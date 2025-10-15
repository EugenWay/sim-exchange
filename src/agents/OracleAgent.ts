/**
 * OracleAgent — external fundamental price process generator.
 * Move fundamental price
 *
 * Modes:
 *  1) OU (Ornstein–Uhlenbeck, mean-reverting, additive, good for "fundamental"):
 *     dF_t = kappa*(mu - F_t)*dt + sigma*dW_t + J_t
 *     Discrete: F_{t+dt} = F_t + kappa*(mu - F_t)*dt + sigma*sqrt(dt)*Z + Jump
 *     (units here are cents; Jump is additive in cents)
 *
 *  2) JDM (Merton jump-diffusion / GBM with Poisson jumps, multiplicative):
 *     dS_t/S_t = mu*dt + sigma*dW_t + J_t
 *     Discrete: S_{t+dt} = S_t * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z + Sum_{i=1..K} ξ_i)
 *     where K ~ Poisson(lambda*dt), ξ_i ~ Normal(muJ, sigmaJ^2)
 *
 * Jumps (Poisson):
 *  - With intensity lambda (per year), at each step draw K ~ Poisson(lambda * dt_years).
 *  - OU: Jump = sum of Normal(0, jumpStdCents^2)  (additive in cents)
 *  - JDM: Jump term is sum of ξ_i added inside the exponent (log-jump sizes).
 *
 * Emits ORACLE_TICK:
 *  { type: ORACLE_TICK, ts, symbol, fundamental, mode, params... }
 *
 * Notes:
 *  - Prices are kept as integer cents.
 *  - dt is derived from wake period; annualization uses 31_557_600 sec/year.
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";

type OracleMode = "OU" | "JDM";

type BaseOpts = {
  symbol: string;
  mode?: OracleMode;
  wakeFreqNs?: number; // update cadence
};

type OUOpts = BaseOpts & {
  r0?: number; // initial fundamental in cents
  mu?: number; // long-run mean in cents
  kappa?: number; // mean reversion speed (per second)
  sigmaCents?: number; // diffusion scale in cents per sqrt(second)
  lambdaAnn?: number; // intensity per year
  jumpStdCents?: number; // jump size std (cents)
};

type JDMOpts = BaseOpts & {
  // GBM params (annualized)
  s0?: number; // initial price in cents
  muAnn?: number; // drift per year (e.g. 0.05 for 5%)
  sigmaAnn?: number; // vol per sqrt(year) (e.g. 0.8)
  // Poisson jumps in log-space
  lambdaAnn?: number; // intensity per year
  muJ?: number; // mean of log-jump size
  sigmaJ?: number; // std of log-jump size
};

export type OracleOpts = OUOpts | JDMOpts;

const SECONDS_PER_YEAR = 31_557_600; // Julian year (for annualization)

export class OracleAgent extends Agent {
  private symbol: string;
  private wakeFreqNs: number;
  private mode: OracleMode;

  // OU state/params
  private r: number;
  private muCents: number;
  private kappa: number;
  private sigmaCentsPerSqrtSec: number;
  private lambdaAnn: number;
  private jumpStdCents: number;

  // JDM state/params
  private sCents: number;
  private muAnn: number;
  private sigmaAnn: number;
  private muJ: number;
  private sigmaJ: number;

  constructor(id: number, opts: OracleOpts) {
    super(id, `Oracle#${id}`);
    this.symbol = opts.symbol;
    this.mode = opts.mode ?? "OU";
    this.wakeFreqNs = opts.wakeFreqNs ?? 150_000_000; // 150 ms

    if (this.mode === "OU") {
      const o = opts as OUOpts;
      this.r = Math.max(1, o.r0 ?? 40_000); // $400
      this.muCents = Math.max(1, o.mu ?? this.r);
      this.kappa = o.kappa ?? 0.02; // per second
      this.sigmaCentsPerSqrtSec = o.sigmaCents ?? 30;
      this.lambdaAnn = o.lambdaAnn ?? 0.05;
      this.jumpStdCents = o.jumpStdCents ?? 200;
      this.sCents = this.r;
      this.muAnn = 0;
      this.sigmaAnn = 0;
      this.muJ = 0;
      this.sigmaJ = 0;
    } else {
      const j = opts as JDMOpts;
      this.sCents = Math.max(1, j.s0 ?? 40_000);
      this.muAnn = j.muAnn ?? 0.0;
      this.sigmaAnn = j.sigmaAnn ?? 0.6;
      this.lambdaAnn = j.lambdaAnn ?? 0.1;
      this.muJ = j.muJ ?? -0.2;
      this.sigmaJ = j.sigmaJ ?? 0.1;
      this.r = this.sCents;
      this.muCents = this.r;
      this.kappa = 0;
      this.sigmaCentsPerSqrtSec = 0;
      this.jumpStdCents = 0;
    }
  }

  kernelStarting(t: number) {
    this.setWakeup(t + this.wakeFreqNs);
  }

  wakeup(t: number) {
    const dtSec = this.wakeFreqNs / 1_000_000_000;
    const dtYears = dtSec / SECONDS_PER_YEAR;

    if (this.mode === "OU") {
      const mr = this.kappa * (this.muCents - this.r) * dtSec;
      const diff = this.gauss(0, this.sigmaCentsPerSqrtSec * Math.sqrt(dtSec));
      const k = this.poisson(this.lambdaAnn * dtYears);
      let jump = 0;
      if (k > 0) {
        jump = this.gauss(0, this.jumpStdCents * Math.sqrt(k));
      }
      this.r = Math.max(1, Math.round(this.r + mr + diff + jump));

      this.kernel.emit({
        type: MsgType.ORACLE_TICK,
        ts: t,
        symbol: this.symbol,
        mode: this.mode,
        fundamental: this.r,
        mu: this.muCents,
        kappa: this.kappa,
        lambdaAnn: this.lambdaAnn,
        lastStep: { mr: Math.round(mr), diff: Math.round(diff), jump: Math.round(jump) },
      });
    } else {
      // JDM / Merton jump-diffusion (multiplicative, log space)
      const drift = (this.muAnn - 0.5 * this.sigmaAnn * this.sigmaAnn) * dtYears;
      const diff = this.sigmaAnn * Math.sqrt(dtYears) * this.gauss(0, 1);
      const k = this.poisson(this.lambdaAnn * dtYears);
      const jumpLog = k > 0 ? this.gauss(k * this.muJ, Math.sqrt(k) * this.sigmaJ) : 0;

      const mult = Math.exp(drift + diff + jumpLog);
      this.sCents = Math.max(1, Math.round(this.sCents * mult));

      this.kernel.emit({
        type: MsgType.ORACLE_TICK,
        ts: t,
        symbol: this.symbol,
        mode: this.mode,
        fundamental: this.sCents,
        muAnn: this.muAnn,
        sigmaAnn: this.sigmaAnn,
        lambdaAnn: this.lambdaAnn,
        lastStep: { drift, diff, jumpLog },
      });
    }

    this.setWakeup(t + this.wakeFreqNs);
  }

  // --- helpers --------------------------------------------------------------

  // standard normal via Box–Muller
  private gauss(mean: number, std: number) {
    if (std <= 0) return 0;
    const u = 1 - Math.random();
    const v = 1 - Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }

  // Poisson(λ) by Knuth (ok for small λ; здесь λ = lambdaAnn * dtYears обычно << 1)
  private poisson(lambda: number) {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
}
