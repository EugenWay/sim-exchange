/**
 * - Keeps a fixed number of levels per side.
 * - Cancels own previous quotes each wake before re-quoting.
 * - Centers around a blend of (mid, oracleFundamental) with inventory skew.
 * - Adaptive spread: target = base + α * sigma(price_changes).
 *
 * Notes:
 * - All prices in cents.
 * - Inventory is updated on ORDER_EXECUTED.
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import type { Side } from "../util/types";
import { RNG } from "../util/rng";

type Open = { id: string; side: Side; price: number; qty: number; ts: number };

export class MarketMaker extends Agent {
  private rng = new RNG();

  // cadence & refresh
  wakeFreqNs = 250_000_000; // 250 ms
  maxModifiesPerWake = 4; // smooth refresh
  maxCancelsPerWake = 4; // smooth refresh
  priceHysteresisCents = 10; // ignore sub-10c drifts

  // quoting
  levels = 3;
  levelQty = 120;
  baseSpread = 80; // cents
  alphaVol = 0.8; // * sigma(mid changes)
  stepBetweenLevels = 25; // level spacing

  // inventory skew (cents per 1 unit inv)
  invSkewCentsPerQty = 0.004;
  private inv = 0;

  // state
  private symbol: string;
  private openOrders: Map<string, Open> = new Map();
  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private last: number | null = null;
  private lastOracleFundamental: number | null = null;

  // rolling mid sigma
  private midHistory: number[] = [];
  private maxHist = 60;

  // one-shot bootstrap flag
  private bootstrapDone = false;

  constructor(id: number, symbol: string) {
    super(id, `MM#${id}`);
    this.symbol = symbol;
  }

  kernelStarting(t: number) {
    this.setWakeup(t);
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.MARKET_DATA && msg.body?.symbol === this.symbol) {
      const bids = msg.body?.bids as [number, number][] | undefined;
      const asks = msg.body?.asks as [number, number][] | undefined;
      this.bestBid = bids?.[0]?.[0] ?? null;
      this.bestAsk = asks?.[0]?.[0] ?? null;
      this.last = msg.body?.last ?? this.last;

      const mid = this.currentMid();
      if (mid != null) {
        this.midHistory.push(mid);
        if (this.midHistory.length > this.maxHist) this.midHistory.shift();
      }
      return;
    }

    if (msg.type === MsgType.ORACLE_TICK && msg.body?.symbol === this.symbol) {
      this.lastOracleFundamental = msg.body.fundamental as number;
      return;
    }

    if (msg.type === MsgType.ORDER_EXECUTED) {
      const { symbol, qty, sideForRecipient, orderId } = msg.body ?? {};
      if (symbol !== this.symbol) return;
      if (sideForRecipient === "BUY") this.inv += qty;
      else if (sideForRecipient === "SELL") this.inv -= qty;
      // if maker order filled, it might be in our map → delete if fully consumed (best-effort)
      if (orderId && this.openOrders.has(orderId)) this.openOrders.delete(orderId);
      return;
    }

    if (msg.type === MsgType.ORDER_CANCELLED) {
      const id = msg.body?.orderId ?? msg.body?.id;
      if (id && this.openOrders.has(id)) this.openOrders.delete(id);
      return;
    }

    if (msg.type === MsgType.ORDER_ACCEPTED) {
      // noop (could reconcile qty after modify)
      return;
    }
  }

  private currentMid(): number | null {
    if (this.bestBid != null && this.bestAsk != null) return Math.floor((this.bestBid + this.bestAsk) / 2);
    if (this.last != null) return this.last;
    return null;
  }

  private sigmaCents(): number {
    if (this.midHistory.length < 6) return 0;
    const diffs: number[] = [];
    for (let i = 1; i < this.midHistory.length; i++) diffs.push(this.midHistory[i]! - this.midHistory[i - 1]!);
    if (diffs.length < 2) return 0;
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const varr = diffs.reduce((a, d) => a + (d - mean) * (d - mean), 0) / (diffs.length - 1);
    return Math.max(0, Math.sqrt(varr));
  }

  private centerPx(): number {
    const mid = this.currentMid();
    if (mid == null) return this.last ?? 40_000;
    const f = this.lastOracleFundamental ?? mid;
    return Math.floor(0.65 * mid + 0.35 * f); // a bit more weight to visible mid
  }

  private desiredLadder(side: Side, center: number, targetSpread: number): number[] {
    const half = Math.floor(targetSpread / 2);
    const skew = Math.round(this.inv * this.invSkewCentsPerQty);
    const baseBid = Math.max(1, center - half - Math.max(0, skew));
    const baseAsk = Math.max(1, center + half - Math.min(0, skew));

    const prices: number[] = [];
    for (let i = 0; i < this.levels; i++) {
      const d = i * this.stepBetweenLevels;
      if (side === "BUY") prices.push(Math.max(1, baseBid - d));
      else prices.push(Math.max(1, baseAsk + d));
    }
    return prices;
  }

  // pick a safe center when no mid yet
  private seedCenter(): number {
    if (this.lastOracleFundamental != null) return this.lastOracleFundamental;
    if (this.last != null) return this.last;
    return 40_000; // cents
  }

  wakeup(t: number) {
    const mid = this.currentMid();

    // If mid is not available yet, place a one-shot bootstrap ladder around a seed center.
    if (mid == null) {
      if (!this.bootstrapDone) {
        const center = this.seedCenter();
        const targetSpread = Math.max(2, Math.round(this.baseSpread)); // no sigma before first ticks
        const wantBids = this.desiredLadder("BUY", center, targetSpread);
        const wantAsks = this.desiredLadder("SELL", center, targetSpread);

        // No currentSide yet; just place the desired ladders.
        this.refreshSide(t, "BUY", wantBids, []);
        this.refreshSide(t, "SELL", wantAsks, []);
        this.bootstrapDone = true;
      }
      this.setWakeup(t + this.wakeFreqNs);
      return; // IMPORTANT: do not proceed without a mid
    }

    const sigma = this.sigmaCents();
    const targetSpread = Math.max(2, Math.round(this.baseSpread + this.alphaVol * sigma));

    const center = this.centerPx();
    const wantBids = this.desiredLadder("BUY", center, targetSpread);
    const wantAsks = this.desiredLadder("SELL", center, targetSpread);

    // Build current state by side
    const curBids = [...this.openOrders.values()].filter((o) => o.side === "BUY");
    const curAsks = [...this.openOrders.values()].filter((o) => o.side === "SELL");

    // Refresh per side
    this.refreshSide(t, "BUY", wantBids, curBids);
    this.refreshSide(t, "SELL", wantAsks, curAsks);

    this.setWakeup(t + this.wakeFreqNs);
  }

  private refreshSide(t: number, side: Side, desiredPrices: number[], currentSide: Open[]) {
    // 1) try to reuse by MODIFY where price drift exceeds hysteresis
    //    sort by proximity to desired to minimize number of operations
    const usedDesired = new Set<number>();
    let modifiesLeft = this.maxModifiesPerWake;
    let cancelsLeft = this.maxCancelsPerWake;

    for (const o of currentSide) {
      let bestIdx = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < desiredPrices.length; i++) {
        if (usedDesired.has(i)) continue;
        const dist = Math.abs(desiredPrices[i]! - o.price);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) {
        // extra order: cancel (rate-limited)
        if (cancelsLeft > 0) {
          this.send(this.kernel.exchangeId, MsgType.CANCEL_ORDER, { id: o.id });
          this.openOrders.delete(o.id);
          cancelsLeft--;
        }
        continue;
      }

      const wantPx = desiredPrices[bestIdx]!;
      usedDesired.add(bestIdx);

      const move = Math.abs(wantPx - o.price);
      if (move >= this.priceHysteresisCents && modifiesLeft > 0) {
        this.send(this.kernel.exchangeId, MsgType.MODIFY_ORDER, { id: o.id, price: wantPx });
        o.price = wantPx;
        o.ts = t;
        modifiesLeft--;
      }
      // else keep as-is
    }

    // 2) place missing levels
    for (let i = 0; i < desiredPrices.length; i++) {
      if (usedDesired.has(i)) continue;
      const price = desiredPrices[i]!;
      const id = `mm-${this.id}-${t}-${side}-${i}-${this.rng.int(1000, 9999)}`;
      this.send(this.kernel.exchangeId, MsgType.LIMIT_ORDER, {
        id,
        agent: this.id,
        symbol: this.symbol,
        side,
        price,
        qty: this.levelQty,
        ts: t,
      });
      this.openOrders.set(id, { id, side, price, qty: this.levelQty, ts: t });
    }
  }
}
