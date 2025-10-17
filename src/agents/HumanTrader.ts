import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { Side } from "../util/types";

export class HumanTrader extends Agent {
  constructor(id: number, public symbol: string, public nameLabel = "HUMAN") {
    super(id, `${nameLabel}#${id}`);
  }

  cash = 100_000_000_00;
  pos: Record<string, number> = Object.create(null);
  private openOrders = new Map<string, { id: string; symbol: string; side: Side; price: number; qty: number; ts: number }>();

  placeLimit(price: number, qty: number, side: Side) {
    const ts = this.kernel.nowNs();
    const order = { id: `H-${ts}`, agent: this.id, symbol: this.symbol, side, price, qty, ts };
    this.openOrders.set(order.id, order);
    this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, order);
    return order.id;
  }

  placeMarket(qty: number, side: Side) {
    this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side, qty });
  }

  cancel(id: string) {
    this.send(this.kernel.exchangeId, MsgType.CANCEL_ORDER, { id });
    this.openOrders.delete(id);
  }

  modify(id: string, patch: { price?: number; qty?: number }) {
    const body: { id: string; price?: number; qty?: number } = { id };
    if (patch.price !== undefined) body.price = patch.price;
    if (patch.qty !== undefined) body.qty = patch.qty;
    this.send(this.kernel.exchangeId, MsgType.MODIFY_ORDER, body);
    const o = this.openOrders.get(id);
    if (o) {
      if (patch.price !== undefined) o.price = patch.price;
      if (patch.qty !== undefined) o.qty = patch.qty;
    }
  }

  listOpen() {
    return Array.from(this.openOrders.values());
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.ORDER_EXECUTED) {
      const { symbol, price, qty, sideForRecipient, orderId } = msg.body as {
        symbol: string;
        price: number;
        qty: number;
        sideForRecipient: "BUY" | "SELL";
        orderId?: string;
      };

      const cur = this.pos[symbol] ?? 0;
      if (sideForRecipient === "BUY") {
        this.pos[symbol] = cur + qty;
        this.cash -= price * qty;
      } else {
        this.pos[symbol] = cur - qty;
        this.cash += price * qty;
      }

      if (orderId) this.openOrders.delete(orderId);
    }

    if (msg.type === MsgType.ORDER_CANCELLED) {
      const id = msg.body?.id;
      if (id) this.openOrders.delete(id);
    }

    if (msg.type === MsgType.ORDER_REJECTED) {
      const id = msg.body?.id;
      if (id) this.openOrders.delete(id);
    }
  }

  getBalances() {
    return { cash: this.cash, pos: this.pos };
  }
}
