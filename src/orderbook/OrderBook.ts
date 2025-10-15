import { L2Level, LimitOrder, Side } from "../util/types";

export class OrderBook {
  symbol: string;
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
    const execs: { price: number; qty: number; maker: number; makerOrderId?: string }[] = [];
    let remain = qty;

    while (remain > 0) {
      if (book.length === 0) break;
      const top = book[0]!;
      const take = Math.min(remain, top.qty);
      execs.push({ price: top.price, qty: take, maker: top.agent, makerOrderId: top.id });
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

  // if price changed — reset priority (ts = nowTs), and resort
  modify(orderId: string, patch: { price?: number; qty?: number }, nowTs?: number) {
    const idxB = this.bids.findIndex((x) => x.id === orderId);
    const idxA = idxB === -1 ? this.asks.findIndex((x) => x.id === orderId) : -1;
    const inBids = idxB >= 0;
    const arr = inBids ? this.bids : this.asks;
    const i = inBids ? idxB : idxA;
    if (i < 0) return { ok: false as const };

    const order = arr[i]!;
    const priceChanged = typeof patch.price === "number" && patch.price !== order.price;

    if (typeof patch.qty === "number") {
      order.qty = Math.max(0, patch.qty);
      if (order.qty === 0) {
        arr.splice(i, 1);
        return { ok: true as const, order: undefined };
      }
    }
    if (typeof patch.price === "number") {
      order.price = patch.price!;
    }

    if (priceChanged && typeof nowTs === "number") {
      order.ts = nowTs;
    }

    this.sortBooks();
    return { ok: true as const, order };
  }

  listOpenOrders(filter?: { agent?: number }) {
    const mapOrder = (o: LimitOrder) => ({ id: o.id, agent: o.agent, side: o.side, price: o.price, qty: o.qty, ts: o.ts });
    let all = [...this.bids.map(mapOrder), ...this.asks.map(mapOrder)];
    if (typeof filter?.agent === "number") all = all.filter((o) => o.agent === filter.agent);
    return all;
  }

  private match() {
    const execs: { price: number; qty: number; maker: number; taker?: number; makerOrderId?: string; takerOrderId?: string }[] = [];
    while (this.bids.length && this.asks.length) {
      const bid = this.bids[0]!;
      const ask = this.asks[0]!;
      if (bid.price < ask.price) break;

      const price = bid.ts <= ask.ts ? bid.price : ask.price;
      const qty = Math.min(bid.qty, ask.qty);
      bid.qty -= qty;
      ask.qty -= qty;
      this.last = price;
      execs.push({
        price,
        qty,
        maker: ask.agent,
        taker: bid.agent,
        makerOrderId: ask.id,
        takerOrderId: bid.id,
      });
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
