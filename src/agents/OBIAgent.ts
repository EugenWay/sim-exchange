/**
 * OBIAgent — Order Book Imbalance agent (ABIDES-inspired).
 * Looks at top K levels and computes bid_pct = bid_liq / (bid_liq + ask_liq).
 * - If bid_pct > 0.5 + entryThreshold => long bias (BUY)
 * - If bid_pct < 0.5 - entryThreshold => short bias (SELL)
 * Trailing stop on bid_pct to exit.
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { RNG } from "../util/rng";

type OBIOpts = {
  symbol: string;
  levels?: number; // how many levels to consider
  entryThreshold?: number; // e.g. 0.12 means enter long at 0.62 or short at 0.38
  trailDist?: number; // trailing stop distance on bid_pct
  wakeFreqNs?: number; // cadence for checks (subscribe to MD anyway)
  lotSize?: number; // how many units to adjust per action
};

export class OBIAgent extends Agent {
  private rng = new RNG();
  private symbol: string;

  private levels: number;
  private entryThreshold: number;
  private trailDist: number;
  private wakeFreqNs: number;
  private lotSize: number;

  private lastBids: [number, number][] = [];
  private lastAsks: [number, number][] = [];

  private isLong = false;
  private isShort = false;
  private trailingStop: number | null = null; // in bid_pct units

  constructor(id: number, opts: OBIOpts) {
    super(id, `OBI#${id}`);
    this.symbol = opts.symbol;
    this.levels = Math.max(1, opts.levels ?? 8);
    this.entryThreshold = opts.entryThreshold ?? 0.14;
    this.trailDist = opts.trailDist ?? 0.08;
    this.wakeFreqNs = opts.wakeFreqNs ?? 220_000_000; // 220ms
    this.lotSize = opts.lotSize ?? 90;
  }

  kernelStarting(t: number) {
    this.setWakeup(t + this.wakeFreqNs);
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.MARKET_DATA && msg.body?.symbol === this.symbol) {
      // store truncated depth
      const bids = (msg.body?.bids as [number, number][]) ?? [];
      const asks = (msg.body?.asks as [number, number][]) ?? [];
      this.lastBids = bids.slice(0, this.levels);
      this.lastAsks = asks.slice(0, this.levels);
    }
  }

  wakeup(t: number) {
    const bidLiq = this.lastBids.reduce((s, [, q]) => s + (q ?? 0), 0);
    const askLiq = this.lastAsks.reduce((s, [, q]) => s + (q ?? 0), 0);

    if (bidLiq <= 0 || askLiq <= 0) {
      this.setWakeup(t + this.wakeFreqNs);
      return;
    }

    const bidPct = bidLiq / (bidLiq + askLiq);
    const longEntry = 0.5 + this.entryThreshold;
    const shortEntry = 0.5 - this.entryThreshold;

    let targetPos = 0; // -1 short, 0 flat, +1 long

    if (this.isShort) {
      // trailing stop follows peak to protect gains
      const newStop = bidPct - this.trailDist;
      if (this.trailingStop == null || newStop > this.trailingStop) this.trailingStop = newStop;
      if (bidPct < (this.trailingStop ?? 0)) {
        this.isShort = false;
        this.trailingStop = null;
        targetPos = 0;
      } else targetPos = -1;
    } else if (this.isLong) {
      const newStop = bidPct + this.trailDist;
      if (this.trailingStop == null || newStop < this.trailingStop) this.trailingStop = newStop;
      if (bidPct > (this.trailingStop ?? 1)) {
        this.isLong = false;
        this.trailingStop = null;
        targetPos = 0;
      } else targetPos = +1;
    } else {
      if (bidPct > longEntry) {
        this.isLong = true;
        this.trailingStop = bidPct + this.trailDist;
        targetPos = +1;
      } else if (bidPct < shortEntry) {
        this.isShort = true;
        this.trailingStop = bidPct - this.trailDist;
        targetPos = -1;
      } else targetPos = 0;
    }

    // enact with market orders (small chunk). In production you'd throttle here.
    if (targetPos > 0) {
      this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side: "BUY", qty: this.lotSize });
    } else if (targetPos < 0) {
      this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, { side: "SELL", qty: this.lotSize });
    }

    this.setWakeup(t + this.wakeFreqNs);
  }
}
