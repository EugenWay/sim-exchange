import { L2Level, LimitOrder, Side } from "../util/types";

export class OrderBook {
  symbol: string;
  // bids: по убыванию цены; asks: по возрастанию
  private bids: LimitOrder[] = [];
  private asks: LimitOrder[] = [];
  last: number | null = null;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  private sortBooks() {
    this.bids.sort((a, b) => b.price - a.price || a.ts - b.ts);
    this.asks.sort((a, b) => a.price - b.price || a.ts - b.ts);
  }

  placeLimit(o: LimitOrder) {
    (o.side === "BUY" ? this.bids : this.asks).push(o);
    this.sortBooks();
    return this.match();
  }

  placeMarket(agent: number, side: Side, qty: number, ts: number) {
    const book = side === "BUY" ? this.asks : this.bids;
    const execs: { price: number; qty: number; maker: number }[] = [];
    let remain = qty;

    while (remain > 0) {
      if (book.length === 0) break; // ← ранний выход
      const top = book[0]!;
      const take = Math.min(remain, top.qty);
      execs.push({ price: top.price, qty: take, maker: top.agent });
      top.qty -= take;
      remain -= take;
      this.last = top.price;
      if (top.qty === 0) book.shift();
    }
    return { filled: qty - remain, execs };
  }

  private match() {
    const execs: { price: number; qty: number; maker: number; taker?: number }[] = [];
    while (this.bids.length && this.asks.length) {
      const bid = this.bids[0]!;
      const ask = this.asks[0]!;
      if (bid.price < ask.price) break; // ← проверка цены до доступа

      const price = bid.ts <= ask.ts ? bid.price : ask.price;
      const qty = Math.min(bid.qty, ask.qty);
      bid.qty -= qty;
      ask.qty -= qty;
      this.last = price;
      execs.push({ price, qty, maker: ask.agent, taker: bid.agent });
      if (bid.qty === 0) this.bids.shift();
      if (ask.qty === 0) this.asks.shift();
    }
    return execs;
  }

  snapshot(depth = 5): { bids: L2Level[]; asks: L2Level[]; last: number | null } {
    const agg = (side: LimitOrder[], asc: boolean): L2Level[] => {
      const map = new Map<number, number>();
      for (const o of side) map.set(o.price, (map.get(o.price) ?? 0) + o.qty);
      const arr = [...map.entries()].sort((a, b) => (asc ? a[0] - b[0] : b[0] - a[0]));
      return arr.slice(0, depth) as L2Level[];
    };
    return { bids: agg(this.bids, false), asks: agg(this.asks, true), last: this.last };
  }
}
