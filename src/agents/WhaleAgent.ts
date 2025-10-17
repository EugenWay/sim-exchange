/**
 * WhaleAgent — large participant with configurable strategy
 *
 * Strategies:
 * - "accumulate"  — gradually builds a long position (buys)
 * - "distribute"  — gradually unwinds a position (sells)
 * - "pump_dump"   — fast accumulation followed by a rapid unwind
 * - "scheduled"   — executes explicit actions on a timetable
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";
import { RNG } from "../util/rng";

type WhaleStrategy = "accumulate" | "distribute" | "pump_dump" | "scheduled";

/** A single scheduled instruction for the "scheduled" strategy. */
type ScheduledAction = {
  /** Seconds since start */
  atSec: number;
  action: "buy" | "sell";
  qty: number;
  /** Optional label for logs */
  description?: string;
};

/** Configuration options for WhaleAgent. */
type WhaleOpts = {
  symbol: string;
  strategy?: WhaleStrategy;

  // accumulate/distribute
  /** Target quantity to accumulate (positive) or distribute (negative via strategy) */
  targetQty?: number;
  /** Time window in seconds to complete the target */
  periodSec?: number;

  // pump_dump
  pumpQty?: number;
  pumpDurationSec?: number;
  dumpDurationSec?: number;

  // scheduled
  schedule?: ScheduledAction[];

  // common
  /** 0..1 — probability to place an aggressive market order on wake */
  aggression?: number;
  /** Wake-up cadence in nanoseconds */
  wakeFreqNs?: number;
};

export class WhaleAgent extends Agent {
  private rng = new RNG();
  private readonly symbol: string;
  private readonly strategy: WhaleStrategy;

  private readonly targetQty: number;
  private readonly periodSec: number;
  private readonly pumpQty: number;
  private readonly pumpDurationSec: number;
  private readonly dumpDurationSec: number;
  private readonly aggression: number;
  private readonly wakeFreqNs: number;
  private readonly schedule: ScheduledAction[];

  private startTimeNs = 0;
  private currentPosition = 0;

  // pump_dump state
  private pumpStartSec = -1;
  private pumpComplete = false;

  // scheduled bookkeeping
  private executedActions = new Set<number>();

  constructor(id: number, opts: WhaleOpts) {
    super(id, `Whale#${id}`);
    this.symbol = opts.symbol;
    this.strategy = opts.strategy ?? "accumulate";

    this.targetQty = opts.targetQty ?? 5_000;
    this.periodSec = opts.periodSec ?? 1800; // 30 min
    this.pumpQty = opts.pumpQty ?? 3_000;
    this.pumpDurationSec = opts.pumpDurationSec ?? 300; // 5 min
    this.dumpDurationSec = opts.dumpDurationSec ?? 180; // 3 min
    this.aggression = opts.aggression ?? 0.7;
    this.wakeFreqNs = opts.wakeFreqNs ?? 250_000_000; // 250 ms
    this.schedule = opts.schedule ?? [];
  }

  kernelStarting(t: number) {
    this.startTimeNs = t;
    console.log(`[${this.name}] Strategy: ${this.strategy}`);
    this.setWakeup(t + this.wakeFreqNs);
  }

  receive(_t: number, msg: any) {
    if (msg.type === MsgType.ORDER_EXECUTED) {
      const { symbol, qty, sideForRecipient } = msg.body ?? {};
      if (symbol !== this.symbol) return;
      if (sideForRecipient === "BUY") this.currentPosition += qty;
      else if (sideForRecipient === "SELL") this.currentPosition -= qty;
    }
  }

  wakeup(t: number) {
    const elapsedSec = (t - this.startTimeNs) / 1_000_000_000;

    switch (this.strategy) {
      case "accumulate":
        this.executeAccumulate(elapsedSec);
        break;
      case "distribute":
        this.executeDistribute(elapsedSec);
        break;
      case "pump_dump":
        this.executePumpDump(t, elapsedSec);
        break;
      case "scheduled":
        this.executeScheduled(elapsedSec);
        break;
    }

    this.setWakeup(t + this.wakeFreqNs);
  }

  private executeAccumulate(elapsedSec: number) {
    // Stop if target reached or window expired
    if (this.currentPosition >= this.targetQty) return;
    if (elapsedSec >= this.periodSec) return;

    const remaining = this.targetQty - this.currentPosition;
    const timeLeft = this.periodSec - elapsedSec;
    const ticksLeft = Math.max(1, Math.floor(timeLeft / (this.wakeFreqNs / 1_000_000_000)));
    const rate = remaining / ticksLeft;

    // Randomized order size around the rate
    const orderSize = Math.min(remaining, Math.max(50, Math.round(rate * (0.8 + this.rng.uniform() * 0.4))));

    // Aggressive buy with probability = aggression
    if (this.rng.uniform() < this.aggression) {
      this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
        side: "BUY",
        qty: orderSize,
      });
    }
  }

  private executeDistribute(elapsedSec: number) {
    // Stop if target reached (negative side) or window expired
    if (this.currentPosition <= -this.targetQty) return;
    if (elapsedSec >= this.periodSec) return;

    const remaining = this.targetQty + this.currentPosition; // how much still to sell
    const timeLeft = this.periodSec - elapsedSec;
    const ticksLeft = Math.max(1, Math.floor(timeLeft / (this.wakeFreqNs / 1_000_000_000)));
    const rate = remaining / ticksLeft;

    const orderSize = Math.min(remaining, Math.max(50, Math.round(rate * (0.8 + this.rng.uniform() * 0.4))));

    // Aggressive sell with probability = aggression
    if (this.rng.uniform() < this.aggression) {
      this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
        side: "SELL",
        qty: orderSize,
      });
    }
  }

  private executePumpDump(_t: number, elapsedSec: number) {
    // Initialize pump phase
    if (this.pumpStartSec < 0) {
      this.pumpStartSec = elapsedSec;
      console.log(`[${this.name}] Starting PUMP at ${Math.floor(elapsedSec)}s`);
    }

    const pumpElapsed = elapsedSec - this.pumpStartSec;

    // PHASE 1: PUMP
    if (!this.pumpComplete && pumpElapsed < this.pumpDurationSec) {
      if (this.currentPosition < this.pumpQty) {
        const remaining = this.pumpQty - this.currentPosition;
        const size = Math.min(remaining, Math.round(150 + this.rng.uniform() * 100));
        this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
          side: "BUY",
          qty: size,
        });
      }
    } else if (!this.pumpComplete) {
      this.pumpComplete = true;
      console.log(`[${this.name}] PUMP complete, position: ${this.currentPosition}. Starting DUMP...`);
    }

    // PHASE 2: DUMP
    if (this.pumpComplete && pumpElapsed < this.pumpDurationSec + this.dumpDurationSec) {
      if (this.currentPosition > 0) {
        const size = Math.min(this.currentPosition, Math.round(200 + this.rng.uniform() * 150));
        this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
          side: "SELL",
          qty: size,
        });
      }
    } else if (this.pumpComplete && pumpElapsed >= this.pumpDurationSec + this.dumpDurationSec) {
      if (!this.executedActions.has(-1)) {
        console.log(`[${this.name}] DUMP complete. Final position: ${this.currentPosition}`);
        this.executedActions.add(-1); // ensure we don't log repeatedly
      }
    }
  }

  private executeScheduled(elapsedSec: number) {
    // Execute actions close to their target times
    for (let i = 0; i < this.schedule.length; i++) {
      const action = this.schedule[i]!;

      if (this.executedActions.has(i)) continue; // already done

      if (Math.abs(elapsedSec - action.atSec) < 3) {
        switch (action.action) {
          case "buy":
            this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
              side: "BUY",
              qty: action.qty,
            });
            if (action.description) {
              console.log(`[${this.name}] ${action.description} (BUY ${action.qty})`);
            }
            break;
          case "sell":
            this.send(this.kernel.exchangeId, MsgType.MARKET_ORDER, {
              side: "SELL",
              qty: action.qty,
            });
            if (action.description) {
              console.log(`[${this.name}] ${action.description} (SELL ${action.qty})`);
            }
            break;
        }

        this.executedActions.add(i);
      }
    }
  }
}

// ============ PREDEFINED PRESETS ============

export const WHALE_PRESETS = {
  // Slow accumulator
  slow_accumulator: {
    strategy: "accumulate" as const,
    targetQty: 6_000,
    periodSec: 3600, // 1 hour
    aggression: 0.5,
  },

  // Fast accumulator
  fast_accumulator: {
    strategy: "accumulate" as const,
    targetQty: 4_000,
    periodSec: 1200, // 20 minutes
    aggression: 0.8,
  },

  // Pump & Dump
  pumper: {
    strategy: "pump_dump" as const,
    pumpQty: 4_000,
    pumpDurationSec: 600, // 10 min pump
    dumpDurationSec: 300, // 5 min dump
    aggression: 0.9,
  },

  // Event-driven schedule
  event_driven: {
    strategy: "scheduled" as const,
    schedule: [
      { atSec: 300, action: "buy" as const, qty: 500, description: "Early buying" },
      { atSec: 900, action: "buy" as const, qty: 800, description: "News catalyst" },
      { atSec: 1800, action: "sell" as const, qty: 600, description: "Profit taking" },
      { atSec: 2700, action: "buy" as const, qty: 1000, description: "Bottom fishing" },
    ],
  },
} as const;
