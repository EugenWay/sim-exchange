import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { Side } from "../util/types";

export class HumanTrader extends Agent {
  constructor(id: number, public symbol: string, public nameLabel = "HUMAN") {
    super(id, `${nameLabel}#${id}`);
  }

  cash = 1_000_000_00;
  pos: Record<string, number> = Object.create(null);

  // REST/API будет вызывать это:
  placeLimit(price: number, qty: number, side: Side) {
    const ts = this.kernel.nowNs();
    const order = { id: `H-${ts}`, agent: this.id, symbol: this.symbol, side, price, qty, ts };
    this.send(this.kernel["exchangeId"], MsgType.LIMIT_ORDER, order);
    return order.id;
  }
  placeMarket(qty: number, side: Side) {
    this.send(this.kernel["exchangeId"], MsgType.MARKET_ORDER, { side, qty });
  }

  receive(_t: number, msg: any) {
    if (msg.type !== MsgType.ORDER_EXECUTED) return;
    const { symbol, price, qty, sideForRecipient } = msg.body as {
      symbol: string;
      price: number;
      qty: number;
      sideForRecipient: "BUY" | "SELL";
    };
    const s = symbol;
    const cur = this.pos[s] ?? 0;

    if (sideForRecipient === "BUY") {
      this.pos[s] = cur + qty;
      this.cash -= price * qty;
    } else {
      this.pos[s] = cur - qty;
      this.cash += price * qty;
    }
  }

  getBalances() {
    return { cash: this.cash, pos: this.pos };
  }
}
