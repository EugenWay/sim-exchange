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
      if (book.length === 0) break;
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

  cancel(orderId: string): { ok: boolean; side?: Side; price?: number; qty?: number } {
    const rm = (arr: LimitOrder[]) => {
      const i = arr.findIndex((o) => o.id === orderId);
      if (i >= 0) {
        const o = arr[i]!;
        arr.splice(i, 1);
        return { ok: true, side: o.side, price: o.price, qty: o.qty } as const;
      }
      return { ok: false } as const;
    };
    const r1 = rm(this.bids);
    if (r1.ok) return r1;
    return rm(this.asks);
  }

  modify(orderId: string, patch: { price?: number; qty?: number }) {
    const fromBids = this.bids.find((x) => x.id === orderId);
    const inBids = !!fromBids;
    const order = fromBids ?? this.asks.find((x) => x.id === orderId);
    if (!order) return { ok: false as const };

    if (typeof patch.qty === "number") {
      order.qty = Math.max(0, patch.qty);
      if (order.qty === 0) {
        // нулевая — это фактически отмена
        if (inBids) this.bids = this.bids.filter((x) => x.id !== orderId);
        else this.asks = this.asks.filter((x) => x.id !== orderId);
        return { ok: true as const, order: undefined };
      }
    }
    if (typeof patch.price === "number") {
      order.price = patch.price;
    }

    this.sortBooks();
    return { ok: true as const, order };
  }

  private match() {
    const execs: { price: number; qty: number; maker: number; taker?: number }[] = [];
    while (this.bids.length && this.asks.length) {
      const bid = this.bids[0]!;
      const ask = this.asks[0]!;
      if (bid.price < ask.price) break;

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
