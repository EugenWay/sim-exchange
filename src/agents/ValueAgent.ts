/**
 * ValueAgent — fundamental trader (ABIDES-style).
 *
 * Key points:
 * - Reads ORACLE_TICK from msg.body (broadcast by OracleAgent).
 * - Kalman-like update of fundamental estimate.
 * - Acts aggressively part of the time, otherwise places passive ladders.
 * - Cancels own passives before new action (as in ABIDES).
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import type { Side } from "../util/types";
import { RNG } from "../util/rng";

type Params = {
  symbol: string;
  rBar?: number;
  kappa?: number;
  sigmaN?: number;
  sigmaS?: number;
  lambdaA?: number;
  percentAggr?: number;
  size?: number;
  depthSpread?: number;
  levels?: number;
  levelQty?: number;
  forecastHorizonSec?: number;
};

type OpenOrder = { id: string; side: Side; price: number; qty: number; ts: number };

export class ValueAgent extends Agent {
  readonly symbol: string;
  private rng = new RNG();

  private rBar: number;
  private kappa: number;
  private sigmaN: number;
  private sigmaS: number;
  private lambdaA: number;

  private percentAggr: number;
  private size: number;
  private depthSpread: number;
  private levels: number;
  private levelQty: number;
  private forecastHorizonSec: number;

  private r_t: number;
  private sigma_t: number;

  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private last: number | null = null;

  private lastOracleFundamental: number | null = null;
  private openOrders: Map<string, OpenOrder> = new Map();

  constructor(id: number, p: Params) {
    super(id, `VAL#${id}`);
    this.symbol = p.symbol;

    // defaults — toned to be realistic and not over-aggressive
    this.rBar = p.rBar ?? 40_000;
    this.kappa = p.kappa ?? 0.05;
    this.sigmaN = p.sigmaN ?? 10_000;
    this.sigmaS = p.sigmaS ?? 100_000;
    this.lambdaA = p.lambdaA ?? 5.0;

    this.percentAggr = p.percentAggr ?? 0.22;
    this.size = p.size ?? 70;
    this.depthSpread = Math.max(0, p.depthSpread ?? 1.5);
    this.levels = Math.max(0, p.levels ?? 2);
    this.levelQty = p.levelQty ?? 70;
    this.forecastHorizonSec = p.forecastHorizonSec ?? 60;

    this.r_t = this.rBar;
    this.sigma_t = 0;
  }

  kernelStarting(t: number) {
    this.scheduleNextWake(t);
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.MARKET_DATA && msg.body?.symbol === this.symbol) {
      const bids = msg.body?.bids as [number, number][] | undefined;
      const asks = msg.body?.asks as [number, number][] | undefined;
      this.bestBid = bids?.[0]?.[0] ?? null;
      this.bestAsk = asks?.[0]?.[0] ?? null;
      this.last = msg.body?.last ?? this.last;
      return;
    }
    if (msg.type === MsgType.ORACLE_TICK && msg.body?.symbol === this.symbol) {
      this.lastOracleFundamental = msg.body.fundamental as number;
      return;
    }
  }

  wakeup(t: number) {
    this.updateFundamentalEstimate();

    const mid = this.currentMid();
    if (mid == null) {
      this.scheduleNextWake(t);
      return;
    }

    const r_T = this.projectToHorizon(this.forecastHorizonSec);

    // clear previous passives (ABIDES-like)
    this.cancelAllPassives();

    const goAggressive = this.rng.uniform() < this.percentAggr;

    if (r_T > mid) {
      if (goAggressive) this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side: "BUY", qty: this.size });
      else this.quotePassively("BUY", mid, t);
    } else if (r_T < mid) {
      if (goAggressive) this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side: "SELL", qty: this.size });
      else this.quotePassively("SELL", mid, t);
    } else {
      this.quotePassively("BUY", mid, t);
      this.quotePassively("SELL", mid, t);
    }

    this.scheduleNextWake(t);
  }

  // internals
  private scheduleNextWake(t: number) {
    const u = Math.max(Number.MIN_VALUE, this.rng.uniform());
    const deltaSec = -Math.log(u) / Math.max(this.lambdaA, 1e-6);
    this.setWakeup(t + Math.max(1, Math.round(deltaSec * 1_000_000_000)));
  }

  private currentMid(): number | null {
    if (this.bestBid != null && this.bestAsk != null) return Math.floor((this.bestBid + this.bestAsk) / 2);
    if (this.last != null) return this.last;
    return null;
  }

  private updateFundamentalEstimate() {
    const dtSec = 1 / Math.max(this.lambdaA, 1e-6);
    const expTerm = Math.exp(-this.kappa * dtSec);

    const r_pred = this.rBar + (this.r_t - this.rBar) * expTerm;
    const sigma_pred = this.sigma_t * expTerm ** 2 + (this.sigmaS / Math.max(2 * this.kappa, 1e-9)) * (1 - expTerm ** 2);

    const baseObs = this.lastOracleFundamental ?? this.rBar;
    const obs = Math.round(baseObs + this.gauss(0, Math.sqrt(this.sigmaN)));

    const K = sigma_pred / (sigma_pred + this.sigmaN);
    this.r_t = Math.round((1 - K) * r_pred + K * obs);
    this.sigma_t = (1 - K) * sigma_pred;
  }

  private projectToHorizon(hSec: number): number {
    const expH = Math.exp(-this.kappa * Math.max(0, hSec));
    return Math.round(this.rBar + (this.r_t - this.rBar) * expH);
  }

  private quotePassively(side: Side, mid: number, t: number) {
    const spread = this.currentSpread() ?? 80;
    const step = Math.max(1, Math.floor(this.depthSpread * spread));
    const levels = Math.max(1, this.levels || 1);
    const qty = Math.max(1, this.levelQty || this.size);

    for (let i = 0; i < levels; i++) {
      const d = (i + 1) * step;
      const price = side === "BUY" ? Math.max(1, mid - d) : Math.max(1, mid + d);

      const id = `${this.name}-${t}-${side}-${i}-${this.rng.int(1000, 9999)}`;
      this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, {
        id,
        agent: this.id,
        symbol: this.symbol,
        side,
        price,
        qty,
        ts: t,
      });
      this.openOrders.set(id, { id, side, price, qty, ts: t });
    }
  }

  private currentSpread(): number | null {
    if (this.bestBid != null && this.bestAsk != null) return Math.max(0, this.bestAsk - this.bestBid);
    return null;
  }

  private cancelAllPassives() {
    if (this.openOrders.size === 0) return;
    for (const o of this.openOrders.values()) {
      this.send(this.kernel.exchangeId, MsgType.CANCEL_ORDER, { id: o.id });
    }
    this.openOrders.clear();
  }

  private gauss(mean: number, std: number) {
    if (std <= 0) return mean;
    const u = 1 - Math.random();
    const v = 1 - Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }
}
