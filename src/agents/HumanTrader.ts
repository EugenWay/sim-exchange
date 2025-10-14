import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { Side } from "../util/types";

export class HumanTrader extends Agent {
  constructor(id: number, public symbol: string, public nameLabel = "HUMAN") {
    super(id, `${nameLabel}#${id}`);
  }

  cash = 1_000_000_00;
  pos: Record<string, number> = Object.create(null);

  placeLimit(price: number, qty: number, side: Side) {
    const ts = this.kernel.nowNs();
    const order = { id: `H-${ts}`, agent: this.id, symbol: this.symbol, side, price, qty, ts };
    this.send(this.kernel["exchangeId"], MsgType.LIMIT_ORDER, order);
    return order.id;
  }

  placeMarket(qty: number, side: Side) {
    this.send(this.kernel["exchangeId"], MsgType.MARKET_ORDER, { side, qty });
  }

  cancel(id: string) {
    this.send(this.kernel["exchangeId"], MsgType.CANCEL_ORDER, { id });
  }
  modify(id: string, patch: { price?: number; qty?: number }) {
    const body: { id: string; price?: number; qty?: number } = { id };
    if (patch.price !== undefined) body.price = patch.price;
    if (patch.qty !== undefined) body.qty = patch.qty;
    this.send(this.kernel.exchangeId, MsgType.MODIFY_ORDER, body);
  }

  receive(_t: number, msg: any) {
    if (msg.type !== MsgType.ORDER_EXECUTED) return;
    const { symbol, price, qty, sideForRecipient } = msg.body as {
      symbol: string;
      price: number;
      qty: number;
      sideForRecipient: "BUY" | "SELL";
    };

    const cur = this.pos[symbol] ?? 0;
    if (sideForRecipient === "BUY") {
      this.pos[symbol] = cur + qty;
      this.cash -= price * qty;
    } else {
      this.pos[symbol] = cur - qty;
      this.cash += price * qty;
    }
  }

  getBalances() {
    return { cash: this.cash, pos: this.pos };
  }
}
