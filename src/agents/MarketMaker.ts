import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { RNG } from "../util/rng";
import { LimitOrder } from "../util/types";

export class MarketMaker extends Agent {
  rng = new RNG();
  wakeFreqNs = 50_000_000;
  targetSpread = 100;
  levelQty = 200;
  levels = 3;

  constructor(id: number, public symbol: string) {
    super(id, `MM#${id}`);
  }

  kernelStarting(t: number) {
    this.setWakeup(t);
  }

  wakeup(t: number) {
    // получаем текущий mid из последнего снапшота ядра
    const book = this.kernel.getBook(this.symbol);
    const snap = book?.snapshot(1);
    const last = snap?.last ?? 40_000; // дефолт $400.00
    const bid0 = last - Math.floor(this.targetSpread / 2);
    const ask0 = last + Math.ceil(this.targetSpread / 2);

    // размещаем по 3 уровня
    for (let i = 0; i < this.levels; i++) {
      const bid: LimitOrder = { id: `b${t}-${i}`, agent: this.id, symbol: this.symbol, side: "BUY", price: bid0 - i * 50, qty: this.levelQty, ts: t };
      const ask: LimitOrder = { id: `a${t}-${i}`, agent: this.id, symbol: this.symbol, side: "SELL", price: ask0 + i * 50, qty: this.levelQty, ts: t };
      this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, bid);
      this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, ask);
    }

    // просыпаемся снова
    this.setWakeup(t + this.wakeFreqNs);
  }
}
