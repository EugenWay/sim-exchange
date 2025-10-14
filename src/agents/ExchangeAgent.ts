import { Agent } from "./Agent";
import { Message, MsgType } from "../messages/types";
import { OrderBook } from "../orderbook/OrderBook";
import { LimitOrder, Side, TradeEvent } from "../util/types";

export class ExchangeAgent extends Agent {
  book: OrderBook;
  pipelineDelay = 40_000;

  constructor(id: number, public symbol: string) {
    super(id, `Exchange(${symbol})`);
    this.book = new OrderBook(symbol);
  }

  receive(t: number, msg: Message) {
    switch (msg.type) {
      case MsgType.LIMIT_ORDER: {
        const o = msg.body as LimitOrder;
        const execs = this.book.placeLimit(o);

        this.send(msg.from, MsgType.ORDER_ACCEPTED, { orderId: o.id, symbol: o.symbol, side: o.side, price: o.price, qty: o.qty }, this.pipelineDelay);

        execs.forEach((e) => {
          const makerSide = (o.side === "BUY" ? "SELL" : "BUY") as Side;
          this.send(o.agent, MsgType.ORDER_EXECUTED, { symbol: this.symbol, price: e.price, qty: e.qty, role: "TAKER", sideForRecipient: o.side }, this.pipelineDelay);
          this.send(e.maker, MsgType.ORDER_EXECUTED, { symbol: this.symbol, price: e.price, qty: e.qty, role: "MAKER", sideForRecipient: makerSide }, this.pipelineDelay);

          this.kernel.emit({
            type: MsgType.TRADE,
            ts: t,
            symbol: this.symbol,
            price: e.price,
            qty: e.qty,
            maker: e.maker,
            taker: o.agent,
            makerSide,
          });
        });

        this.publish();
        break;
      }

      case MsgType.MARKET_ORDER: {
        const { side, qty } = msg.body as { side: Side; qty: number };
        const res = this.book.placeMarket(msg.from, side, qty, t);

        if (res.filled > 0) {
          res.execs.forEach((e) => {
            const makerSide = (side === "BUY" ? "SELL" : "BUY") as Side;

            this.send(msg.from, MsgType.ORDER_EXECUTED, { symbol: this.symbol, price: e.price, qty: e.qty, role: "TAKER", sideForRecipient: side }, this.pipelineDelay);
            this.send(e.maker, MsgType.ORDER_EXECUTED, { symbol: this.symbol, price: e.price, qty: e.qty, role: "MAKER", sideForRecipient: makerSide }, this.pipelineDelay);

            this.kernel.emit({
              type: MsgType.TRADE,
              ts: t,
              symbol: this.symbol,
              price: e.price,
              qty: e.qty,
              maker: e.maker,
              taker: msg.from,
              makerSide,
            });
          });
        }
        this.publish();
        break;
      }

      case MsgType.CANCEL_ORDER: {
        const { id } = (msg.body ?? {}) as { id?: string };
        if (!id) break;

        const res = this.book.cancel(id);
        this.send(msg.from, MsgType.ORDER_CANCELLED, { orderId: id, ok: res.ok, side: res.side, price: res.price, qty: res.qty }, this.pipelineDelay);

        this.kernel.emit({
          type: MsgType.ORDER_LOG,
          ts: t,
          from: msg.from,
          to: this.id,
          msgType: MsgType.CANCEL_ORDER,
          body: { id, ok: res.ok },
        });

        this.publish();
        break;
      }

      case MsgType.MODIFY_ORDER: {
        const { id, price, qty } = (msg.body ?? {}) as { id?: string; price?: number; qty?: number };
        if (!id) break;

        const patch: { price?: number; qty?: number } = {};
        if (price !== undefined) patch.price = price;
        if (qty !== undefined) patch.qty = qty;

        const res = this.book.modify(id, patch);

        this.send(msg.from, MsgType.ORDER_ACCEPTED, { orderId: id, replaced: res.ok, ...patch }, this.pipelineDelay);

        this.kernel.emit({
          type: MsgType.ORDER_LOG,
          ts: t,
          from: msg.from,
          to: this.id,
          msgType: MsgType.MODIFY_ORDER,
          body: { id, ...patch, ok: res.ok },
        });

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
    this.kernel.broadcast(MsgType.MARKET_DATA, {
      symbol: this.book.symbol,
      ...snap,
    });
  }
}
