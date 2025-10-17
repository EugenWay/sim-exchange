/**
 * NoiseTaker with fat tails + mild flow imbalance.
 * - Most orders are small; sometimes draws a large order (tail).
 * - Buy/sell bias drifts over time in regimes (to break symmetry).
 */

import { Agent } from "./Agent";
import { RNG } from "../util/rng";
import { MsgType } from "../messages/types";

export class NoiseTaker extends Agent {
  private rng = new RNG();
  private symbol: string;

  freqNs = 170_000_000; // 170ms
  smallMaxQty = 50;
  tailProb = 0.12;
  largeMinQty = 80;
  largeMaxQty = 220;

  // regime-based buy bias
  private buyBias = 0.5;
  private regimeUntilNs = 0;
  private regimeMinDurNs = 2_000_000_000; // 2s
  private regimeMaxDurNs = 6_000_000_000; // 6s

  constructor(id: number, symbol: string) {
    super(id, `Noise#${id}`);
    this.symbol = symbol;
  }

  kernelStarting(t: number) {
    this.pickNewRegime(t);
    this.setWakeup(t + this.freqNs);
  }

  private pickNewRegime(t: number) {
    const shift = (this.rng.uniform() - 0.5) * 0.1; // ±0.05
    this.buyBias = Math.min(0.62, Math.max(0.38, 0.5 + shift));
    const dur = this.rng.int(this.regimeMinDurNs, this.regimeMaxDurNs);
    this.regimeUntilNs = t + dur;
  }

  private sampleQty() {
    if (this.rng.uniform() < this.tailProb) {
      return this.rng.int(this.largeMinQty, this.largeMaxQty);
    }
    return this.rng.int(10, this.smallMaxQty);
  }

  wakeup(t: number) {
    if (t >= this.regimeUntilNs) this.pickNewRegime(t);

    const buy = this.rng.uniform() < this.buyBias;
    const qty = this.sampleQty();

    this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
      side: buy ? "BUY" : "SELL",
      qty,
    });

    this.setWakeup(t + this.freqNs);
  }
}
