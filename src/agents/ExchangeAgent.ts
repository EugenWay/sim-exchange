import { Agent } from "./Agent";
import { Message, MsgType, RejectBody } from "../messages/types";
import { OrderBook } from "../orderbook/OrderBook";
import { LimitOrder, Side } from "../util/types";

export class ExchangeAgent extends Agent {
  book: OrderBook;

  constructor(id: number, public symbol: string) {
    super(id, `Exchange(${symbol})`);
    this.book = new OrderBook(symbol);
  }

  private reject(to: number, refType: MsgType, reason: string, ref?: any) {
    const body: RejectBody = { reason, refType, ref };
    this.send(to, MsgType.ORDER_REJECTED, body);
  }

  receive(t: number, msg: Message) {
    switch (msg.type) {
      case MsgType.LIMIT_ORDER: {
        const o = msg.body as LimitOrder;
        if (!o || o.symbol !== this.symbol) {
          this.reject(msg.from, MsgType.LIMIT_ORDER, "Symbol mismatch", o);
          break;
        }
        if (o.qty <= 0 || o.price <= 0) {
          this.reject(msg.from, MsgType.LIMIT_ORDER, "Non-positive qty or price", o);
          break;
        }
        if (o.side !== "BUY" && o.side !== "SELL") {
          this.reject(msg.from, MsgType.LIMIT_ORDER, "Invalid side", o);
          break;
        }

        const execs = this.book.placeLimit(o);

        this.send(msg.from, MsgType.ORDER_ACCEPTED, { orderId: o.id, symbol: o.symbol, side: o.side, price: o.price, qty: o.qty });

        execs.forEach((e) => {
          const makerSide = (o.side === "BUY" ? "SELL" : "BUY") as Side;
          this.send(o.agent, MsgType.ORDER_EXECUTED, {
            symbol: this.symbol,
            price: e.price,
            qty: e.qty,
            role: "TAKER",
            sideForRecipient: o.side,
            orderId: o.id,
          });
          this.send(e.maker, MsgType.ORDER_EXECUTED, {
            symbol: this.symbol,
            price: e.price,
            qty: e.qty,
            role: "MAKER",
            sideForRecipient: makerSide,
            orderId: e.makerOrderId,
          });

          this.kernel.emit({ type: MsgType.TRADE, ts: t, symbol: this.symbol, price: e.price, qty: e.qty, maker: e.maker, taker: o.agent, makerSide });
        });

        this.publish();
        break;
      }

      case MsgType.MARKET_ORDER: {
        const { side, qty } = (msg.body ?? {}) as { side?: Side; qty?: number };
        if (!side || (side !== "BUY" && side !== "SELL")) {
          this.reject(msg.from, MsgType.MARKET_ORDER, "Invalid side", msg.body);
          break;
        }
        if (!qty || qty <= 0) {
          this.reject(msg.from, MsgType.MARKET_ORDER, "Non-positive qty", msg.body);
          break;
        }

        const res = this.book.placeMarket(msg.from, side, qty, t);

        if (res.filled > 0) {
          res.execs.forEach((e) => {
            const makerSide = (side === "BUY" ? "SELL" : "BUY") as Side;
            this.send(msg.from, MsgType.ORDER_EXECUTED, {
              symbol: this.symbol,
              price: e.price,
              qty: e.qty,
              role: "TAKER",
              sideForRecipient: side,
            });
            this.send(e.maker, MsgType.ORDER_EXECUTED, {
              symbol: this.symbol,
              price: e.price,
              qty: e.qty,
              role: "MAKER",
              sideForRecipient: makerSide,
              orderId: e.makerOrderId,
            });
            this.kernel.emit({ type: MsgType.TRADE, ts: t, symbol: this.symbol, price: e.price, qty: e.qty, maker: e.maker, taker: msg.from, makerSide });
          });
        } else {
          this.reject(msg.from, MsgType.MARKET_ORDER, "No liquidity", msg.body);
        }
        this.publish();
        break;
      }

      case MsgType.CANCEL_ORDER: {
        const { id } = (msg.body ?? {}) as { id?: string };
        if (!id) {
          this.reject(msg.from, MsgType.CANCEL_ORDER, "Missing order id", msg.body);
          break;
        }

        const res = this.book.cancel(id);
        if (res.ok) {
          this.send(msg.from, MsgType.ORDER_CANCELLED, { orderId: id, side: res.side, price: res.price, qty: res.qty });
          this.kernel.emit({ type: MsgType.ORDER_LOG, ts: t, from: msg.from, to: this.id, msgType: MsgType.CANCEL_ORDER, body: { id } });
          this.publish();
        } else {
          this.reject(msg.from, MsgType.CANCEL_ORDER, "Unknown order id", { id });
        }
        break;
      }

      case MsgType.MODIFY_ORDER: {
        const { id, price, qty } = (msg.body ?? {}) as { id?: string; price?: number; qty?: number };
        if (!id) {
          this.reject(msg.from, MsgType.MODIFY_ORDER, "Missing order id", msg.body);
          break;
        }
        if (price !== undefined && price <= 0) {
          this.reject(msg.from, MsgType.MODIFY_ORDER, "Non-positive price", msg.body);
          break;
        }
        if (qty !== undefined && qty < 0) {
          this.reject(msg.from, MsgType.MODIFY_ORDER, "Negative qty", msg.body);
          break;
        }

        const patch = {
          ...(price !== undefined ? { price } : {}),
          ...(qty !== undefined ? { qty } : {}),
        } as { price?: number; qty?: number };
        const res = this.book.modify(id, patch, t);
        if (!res.ok) {
          this.reject(msg.from, MsgType.MODIFY_ORDER, "Unknown order id", { id });
          break;
        }
        this.send(msg.from, MsgType.ORDER_ACCEPTED, { orderId: id, replaced: true, price, qty });
        this.kernel.emit({ type: MsgType.ORDER_LOG, ts: t, from: msg.from, to: this.id, msgType: MsgType.MODIFY_ORDER, body: { id, price, qty } });
        this.publish();
        break;
      }

      case MsgType.QUERY_SPREAD: {
        const snap = this.book.snapshot(msg.body?.depth ?? 5);
        this.send(msg.from, MsgType.QUERY_SPREAD, { symbol: this.symbol, ...snap });
        break;
      }
      case MsgType.QUERY_LAST: {
        this.send(msg.from, MsgType.QUERY_LAST, { symbol: this.symbol, last: this.book.last });
        break;
      }
    }
  }

  private publish() {
    const snap = this.book.snapshot(10);
    this.kernel.broadcast(MsgType.MARKET_DATA, { symbol: this.book.symbol, ...snap });
  }

  listOpenOrders(filter?: { agent?: number }) {
    return this.book.listOpenOrders(filter);
  }
}
