/**
 * TradeAgent — lightweight trend-following + passive quoting agent.
 *
 * Behavior:
 * - Subscribes to MARKET_DATA snapshots (last, bids/asks).
 * - Maintains two EMAs (short/long) on last price.
 * - If short EMA exceeds long EMA by a threshold -> send MARKET BUY.
 *   If short EMA below long EMA by threshold -> send MARKET SELL.
 * - When no clear trend -> place passive buy/sell LIMIT orders near best bid/ask.
 * - Manages its own passive orders with a TTL: cancels outdated orders automatically.
 * - Tracks simple P&L/position using ORDER_EXECUTED with sideForRecipient.
 *
 * Notes:
 * - This is intentionally simple and self-contained (no global risk manager).
 * - Uses our message bus (LIMIT_ORDER / MARKET_ORDER / CANCEL_ORDER / ORDER_EXECUTED).
 * - Keeps its own open-order map to support time-based cancels.
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import type { LimitOrder, Side } from "../util/types";
import { RNG } from "../util/rng";

type Ema = { v: number | null; k: number };
function emaUpdate(e: Ema, price: number) {
  if (e.v == null) e.v = price;
  else e.v = e.v + e.k * (price - e.v);
  return e.v!;
}

export type TradeAgentOpts = {
  symbol: string;
  wakeFreqNs?: number;
  shortPeriod?: number;
  longPeriod?: number;
  thresholdBp?: number;
  signalQty?: number;
  passiveLevels?: number;
  passiveStep?: number;
  passiveQty?: number;
  orderTtlNs?: number;
  maxPosition?: number;
};

type OpenOrderMeta = { id: string; ts: number; side: Side; price: number; qty: number };

export class TradeAgent extends Agent {
  readonly symbol: string;
  private rng = new RNG();

  private wakeFreqNs: number;
  private short: Ema;
  private long: Ema;
  private thresholdBp: number;
  private signalQty: number;

  private passiveLevels: number;
  private passiveStep: number;
  private passiveQty: number;
  private orderTtlNs: number;
  private maxPosition: number;

  private bestBid: number | null = null;
  private bestAsk: number | null = null;

  private openOrders: Map<string, OpenOrderMeta> = new Map();
  private pos = 0;
  private cash = 0;

  constructor(id: number, opts: TradeAgentOpts) {
    super(id, `TA#${id}`);
    this.symbol = opts.symbol;

    this.wakeFreqNs = opts.wakeFreqNs ?? 140_000_000;
    const shortP = opts.shortPeriod ?? 8;
    const longP = opts.longPeriod ?? 21;
    this.short = { v: null, k: 2 / (shortP + 1) };
    this.long = { v: null, k: 2 / (longP + 1) };
    this.thresholdBp = opts.thresholdBp ?? 5;
    this.signalQty = opts.signalQty ?? 50;

    this.passiveLevels = opts.passiveLevels ?? 2;
    this.passiveStep = opts.passiveStep ?? 20;
    this.passiveQty = opts.passiveQty ?? 60;
    this.orderTtlNs = opts.orderTtlNs ?? 700_000_000; // 0.7s
    this.maxPosition = opts.maxPosition ?? 5_000;
  }

  kernelStarting(t: number) {
    this.setWakeup(t + this.wakeFreqNs);
  }

  wakeup(t: number) {
    this.sweepExpired(t);

    if (this.hasSignal()) {
      const dirBuy = this.short.v! > this.long.v!;
      const side: Side = dirBuy ? "BUY" : "SELL";

      if (dirBuy && this.pos + this.signalQty <= this.maxPosition) {
        this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side, qty: this.signalQty });
      } else if (!dirBuy && this.pos - this.signalQty >= -this.maxPosition) {
        this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side, qty: this.signalQty });
      }

      this.cancelAllPassives();
      this.placePassives(t);
    } else {
      if (this.countPassives() === 0) this.placePassives(t);
    }

    this.setWakeup(t + this.wakeFreqNs);
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.MARKET_DATA && msg.body?.symbol === this.symbol) {
      const last = msg.body.last as number | null;
      if (last != null) {
        emaUpdate(this.short, last);
        emaUpdate(this.long, last);
      }
      const bids = msg.body?.bids as [number, number][] | undefined;
      const asks = msg.body?.asks as [number, number][] | undefined;
      this.bestBid = bids?.[0]?.[0] ?? null;
      this.bestAsk = asks?.[0]?.[0] ?? null;
      return;
    }

    if (msg.type === MsgType.ORDER_EXECUTED) {
      const { symbol, price, qty, sideForRecipient } = msg.body ?? {};
      if (symbol !== this.symbol) return;
      if (sideForRecipient === "BUY") {
        this.pos += qty;
        this.cash -= price * qty;
      } else {
        this.pos -= qty;
        this.cash += price * qty;
      }
    }
  }

  // helpers
  private hasSignal(): boolean {
    if (this.short.v == null || this.long.v == null) return false;
    const s = this.short.v!,
      l = this.long.v!;
    if (l <= 0) return false;
    const diffBp = (Math.abs(s - l) * 10000) / l;
    return diffBp >= this.thresholdBp;
  }

  private placePassives(t: number) {
    if (this.bestBid == null || this.bestAsk == null) return;
    const mid = Math.floor((this.bestBid + this.bestAsk) / 2);

    for (let i = 0; i < this.passiveLevels; i++) {
      const bidPx = Math.max(1, mid - (i + 1) * this.passiveStep);
      const askPx = Math.max(1, mid + (i + 1) * this.passiveStep);
      const bidId = this.placeLimitLocal(t, "BUY", bidPx, this.passiveQty);
      const askId = this.placeLimitLocal(t, "SELL", askPx, this.passiveQty);
      this.openOrders.set(bidId, { id: bidId, ts: t, side: "BUY", price: bidPx, qty: this.passiveQty });
      this.openOrders.set(askId, { id: askId, ts: t, side: "SELL", price: askPx, qty: this.passiveQty });
    }
  }

  private placeLimitLocal(t: number, side: Side, price: number, qty: number) {
    const id = `${this.name}-${t}-${side}-${this.rng.int(1000, 9999)}`;
    const order: LimitOrder = { id, agent: this.id, symbol: this.symbol, side, price, qty, ts: t };
    this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, order);
    return id;
  }

  private sweepExpired(t: number) {
    if (this.openOrders.size === 0) return;
    for (const o of [...this.openOrders.values()]) {
      if (t >= o.ts + this.orderTtlNs) {
        this.send(this.kernel.exchangeId, MsgType.CANCEL_ORDER, { id: o.id });
        this.openOrders.delete(o.id);
      }
    }
  }

  private cancelAllPassives() {
    for (const o of [...this.openOrders.values()]) {
      this.send(this.kernel.exchangeId, MsgType.CANCEL_ORDER, { id: o.id });
      this.openOrders.delete(o.id);
    }
  }

  private countPassives() {
    return this.openOrders.size;
  }
}
