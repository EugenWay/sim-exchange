import { Agent } from "./Agent";
import { RNG } from "../util/rng";
import { MsgType } from "../messages/types";

export class NoiseTaker extends Agent {
  rng = new RNG();
  symbol: string;
  freqNs = 200_000_000; // 200ms
  maxQty = 50;

  constructor(id: number, symbol: string) {
    super(id, `Noise#${id}`);
    this.symbol = symbol;
  }

  kernelStarting(t: number) {
    this.setWakeup(t + this.freqNs);
  }

  wakeup(t: number) {
    const buy = this.rng.uniform() < 0.5;
    const qty = 1 + this.rng.int(1, this.maxQty);
    this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side: buy ? "BUY" : "SELL", qty });
    this.setWakeup(t + this.freqNs);
  }
}
