/**
 * ScenarioOracle — time-driven price oracle for simulations
 *
 * - Follows a predefined array of scenario points { atSec, price, volatility, event }.
 * - Interpolates target price between points (linear or smoothstep).
 * - Adds Gaussian noise scaled by local volatility and wake frequency.
 * - Smoothly drifts current price toward the target at each tick and broadcasts ORACLE_TICK.
 */

import { Agent } from "./Agent";
import { MsgType } from "../messages/types";

/** A single keyframe in the scenario timeline. */
type ScenarioPoint = {
  /** Seconds since scenario start */
  atSec: number;
  /** Target price in cents */
  price: number;
  /** Local volatility (arbitrary units). If omitted, baseVolatility is used */
  volatility?: number;
  /** Optional log label for this point */
  event?: string;
};

/** Configuration for the scenario-driven oracle. */
type ScenarioConfig = {
  points: ScenarioPoint[];
  /** Default local volatility if a point doesn't specify one */
  baseVolatility?: number;
  /** Interpolation method between points */
  interpolation?: "linear" | "smooth";
};

/** Constructor options for ScenarioOracle. */
type ScenarioOracleOpts = {
  symbol: string;
  scenario: ScenarioConfig;
  /** Wake-up cadence in nanoseconds (default: 150ms) */
  wakeFreqNs?: number;
  /** 0..1 — scales the applied noise magnitude */
  noiseScale?: number;
};

export class ScenarioOracle extends Agent {
  private readonly symbol: string;
  private readonly wakeFreqNs: number;
  private readonly scenario: ScenarioConfig;
  private readonly noiseScale: number;

  private currentPrice: number;
  private startTimeNs = 0;

  constructor(id: number, opts: ScenarioOracleOpts) {
    super(id, `Oracle#${id}`);
    this.symbol = opts.symbol;
    this.scenario = opts.scenario;
    this.wakeFreqNs = opts.wakeFreqNs ?? 150_000_000; // 150 ms
    this.noiseScale = opts.noiseScale ?? 0.4;

    // Initialize price from the first scenario point or a sane default
    this.currentPrice = this.scenario.points[0]?.price ?? 40_000;
  }

  kernelStarting(t: number) {
    this.startTimeNs = t;
    console.log(`[${this.name}] Starting scenario with ${this.scenario.points.length} points`);
    this.setWakeup(t + this.wakeFreqNs);
  }

  wakeup(t: number) {
    const elapsedSec = (t - this.startTimeNs) / 1_000_000_000;
    const dtSec = this.wakeFreqNs / 1_000_000_000;

    // Determine target price and local volatility for current time
    const { target, volatility } = this.interpolateScenario(elapsedSec);

    // Gaussian noise scaled by volatility and timestep
    const noise = this.gauss(0, volatility * Math.sqrt(dtSec)) * this.noiseScale;

    // Drift current price toward target
    const drift = (target - this.currentPrice) * dtSec * 2; // 2 = approach speed factor
    this.currentPrice = Math.max(1, Math.round(this.currentPrice + drift + noise));

    const body = {
      ts: t,
      symbol: this.symbol,
      fundamental: this.currentPrice,
      target: target,
      elapsedSec: Math.round(elapsedSec),
    };

    // Emit for logs and broadcast to all agents
    this.kernel.emit({ type: MsgType.ORACLE_TICK, ...body });
    this.kernel.broadcast(MsgType.ORACLE_TICK, body);

    this.setWakeup(t + this.wakeFreqNs);
  }

  /**
   * Interpolate the scenario at a given elapsed time.
   *
   * - If elapsed is after the last point, returns the last point's target/volatility.
   * - Between two points, interpolates price using the configured method.
   */
  private interpolateScenario(elapsedSec: number): { target: number; volatility: number } {
    const points = this.scenario.points;
    const baseVol = this.scenario.baseVolatility ?? 50;

    if (points.length === 0) {
      return { target: this.currentPrice, volatility: baseVol };
    }

    // Find prev/next points for interpolation window
    let prev = points[0]!;
    let next = points[0]!;

    for (let i = 0; i < points.length; i++) {
      if (points[i]!.atSec <= elapsedSec) {
        prev = points[i]!;
      }
      if (points[i]!.atSec > elapsedSec) {
        next = points[i]!;
        break;
      }
    }

    // After the last point: hold the last target and volatility
    if (elapsedSec >= points[points.length - 1]!.atSec) {
      const last = points[points.length - 1]!;
      return {
        target: last.price,
        volatility: last.volatility ?? baseVol,
      };
    }

    // Interpolate between prev and next
    const duration = next.atSec - prev.atSec;
    const progress = duration > 0 ? (elapsedSec - prev.atSec) / duration : 1;

    let target: number;
    if (this.scenario.interpolation === "smooth") {
      // Smoothstep easing
      const s = progress * progress * (3 - 2 * progress);
      target = prev.price + (next.price - prev.price) * s;
    } else {
      // Linear
      target = prev.price + (next.price - prev.price) * progress;
    }

    const vol = prev.volatility ?? baseVol;
    return { target: Math.round(target), volatility: vol };
  }

  /** Box–Muller transform for standard normal → scaled normal */
  private gauss(mean: number, std: number): number {
    if (std <= 0) return mean;
    const u = 1 - Math.random();
    const v = 1 - Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }
}

// ============ PREDEFINED SCENARIOS ============

export const SCENARIOS = {
  // Bullish trend with pullbacks (1 hour)
  bullish_hour: {
    points: [
      { atSec: 0, price: 40_000, volatility: 40, event: "Market open" },
      { atSec: 600, price: 41_200, volatility: 60, event: "Early buying" },
      { atSec: 1200, price: 40_800, volatility: 50, event: "Small correction" },
      { atSec: 1800, price: 42_500, volatility: 70, event: "Breakout" },
      { atSec: 2400, price: 42_000, volatility: 55, event: "Consolidation" },
      { atSec: 3000, price: 43_800, volatility: 80, event: "Strong rally" },
      { atSec: 3600, price: 44_500, volatility: 60, event: "New high" },
    ],
    baseVolatility: 50,
    interpolation: "smooth" as const,
  },

  // Bearish trend (1 hour)
  bearish_hour: {
    points: [
      { atSec: 0, price: 40_000, volatility: 40 },
      { atSec: 600, price: 39_200, volatility: 60 },
      { atSec: 1200, price: 39_600, volatility: 50 },
      { atSec: 1800, price: 38_200, volatility: 70 },
      { atSec: 2400, price: 38_500, volatility: 55 },
      { atSec: 3000, price: 37_000, volatility: 80 },
      { atSec: 3600, price: 36_500, volatility: 50 },
    ],
    baseVolatility: 50,
    interpolation: "smooth" as const,
  },

  // Highly volatile session with labeled events (1 hour)
  volatile_hour: {
    points: [
      { atSec: 0, price: 40_000, volatility: 40, event: "Start" },
      { atSec: 300, price: 41_500, volatility: 100, event: "News pump" },
      { atSec: 600, price: 39_500, volatility: 120, event: "Dump" },
      { atSec: 900, price: 40_200, volatility: 60, event: "Recovery" },
      { atSec: 1200, price: 42_000, volatility: 90, event: "FOMO" },
      { atSec: 1500, price: 40_800, volatility: 100, event: "Panic" },
      { atSec: 1800, price: 41_800, volatility: 80, event: "Buy dip" },
      { atSec: 2100, price: 39_800, volatility: 110, event: "Whale dump" },
      { atSec: 2400, price: 41_200, volatility: 90, event: "Accumulation" },
      { atSec: 2700, price: 43_500, volatility: 100, event: "Breakout" },
      { atSec: 3000, price: 42_500, volatility: 80, event: "Consolidation" },
      { atSec: 3600, price: 43_000, volatility: 60, event: "Close" },
    ],
    baseVolatility: 70,
    interpolation: "smooth" as const,
  },

  // Range-bound session with breakout (1 hour)
  sideways_breakout: {
    points: [
      { atSec: 0, price: 40_000, volatility: 30, event: "Range start" },
      { atSec: 600, price: 40_300, volatility: 35 },
      { atSec: 1200, price: 39_800, volatility: 35 },
      { atSec: 1800, price: 40_200, volatility: 30 },
      { atSec: 2100, price: 42_200, volatility: 100, event: "BREAKOUT!" },
      { atSec: 2400, price: 41_800, volatility: 70, event: "Retest" },
      { atSec: 2700, price: 43_000, volatility: 80, event: "Continuation" },
      { atSec: 3300, price: 44_200, volatility: 70 },
      { atSec: 3600, price: 44_500, volatility: 60, event: "End" },
    ],
    baseVolatility: 35,
    interpolation: "smooth" as const,
  },

  // Short quick test (15 minutes)
  quick_test: {
    points: [
      { atSec: 0, price: 40_000, volatility: 50 },
      { atSec: 300, price: 41_000, volatility: 70 },
      { atSec: 600, price: 40_500, volatility: 60 },
      { atSec: 900, price: 42_000, volatility: 80 },
    ],
    baseVolatility: 60,
    interpolation: "smooth" as const,
  },
} as const;
