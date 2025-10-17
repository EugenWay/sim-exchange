import fs from "fs";
import path from "path";
import { Command } from "commander";

import { Kernel } from "./kernel/Kernel";
import { TwoStageRpcLatency } from "./kernel/LatencyModel";
import { ExchangeAgent } from "./agents/ExchangeAgent";
import { MarketMaker } from "./agents/MarketMaker";
import { NoiseTaker } from "./agents/NoiseTaker";
import { TradeAgent } from "./agents/TradeAgent";
import { OracleAgent } from "./agents/OracleAgent";
import { HumanTrader } from "./agents/HumanTrader";
import { ValueAgent } from "./agents/ValueAgent";
import { OBIAgent } from "./agents/OBIAgent";

import { startApi } from "./server/api";
import { CsvLog } from "./util/csvlog";
import { MsgType } from "./messages/types";
import { nowNs } from "./util/time";

/** ----------------------------
 *  Types for scenario
 *  --------------------------- */
type AgentDecl = {
  type: "MarketMaker" | "NoiseTaker" | "TradeAgent" | "OracleAgent" | "ValueAgent" | "OBIAgent";
  count?: number;
  params?: any;
};

type SymbolDecl = {
  symbol: string;
  agents: AgentDecl[];
};

type Scenario = {
  name?: string;
  durationMs?: number;
  tickMs?: number;
  logging?: {
    enabled?: boolean;
    dir?: string;
    orders?: boolean;
    trades?: boolean;
    oracle?: boolean;
  };
  latency?: {
    rpcUpMs?: number;
    rpcDownMs?: number;
    computeMs?: number;
    downJitterMs?: number;
  };
  symbols: SymbolDecl[];
};

/** ----------------------------
 *  CLI
 *  --------------------------- */
const program = new Command();
program.option("-c, --config <file>", "scenario JSON path", "scenarios/jump-demo.json").option("--dur <ms>", "override durationMs").option("--tick <ms>", "override tickMs").option("--port <n>", "HTTP port", "3000").option("--log-dir <path>", "override log dir").option("--no-logs", "disable all logs");

program.parse();
const cli = program.opts();

/** ----------------------------
 *  Load & normalize scenario
 *  --------------------------- */
function loadScenario(p: string): Scenario {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(raw) as Scenario;
  if (!json.symbols || json.symbols.length === 0) {
    throw new Error("Scenario must contain at least one symbol.");
  }
  // Current kernel supports single exchangeId → limit to 1 symbol
  if (json.symbols.length > 1) {
    throw new Error("Current Kernel supports one exchange (one symbol) per run. Provide exactly one item in symbols[].");
  }
  return json;
}
const scenario = loadScenario(cli.config);

/** apply CLI overrides */
if (cli.dur) scenario.durationMs = parseInt(cli.dur, 10);
if (cli.tick) scenario.tickMs = parseInt(cli.tick, 10);
if (cli.logs === false) scenario.logging = { ...(scenario.logging ?? {}), enabled: false };
if (cli.logDir) scenario.logging = { ...(scenario.logging ?? {}), dir: String(cli.logDir) };

const durationMs = scenario.durationMs ?? 300_000;
const tickMs = scenario.tickMs ?? 200;

const latency = {
  rpcUpMs: scenario.latency?.rpcUpMs ?? 200,
  rpcDownMs: scenario.latency?.rpcDownMs ?? 200,
  computeMs: scenario.latency?.computeMs ?? 300,
  downJitterMs: scenario.latency?.downJitterMs ?? 0,
};

const logging = {
  enabled: scenario.logging?.enabled ?? true,
  dir: scenario.logging?.dir ?? "./logs",
  orders: scenario.logging?.orders ?? true,
  trades: scenario.logging?.trades ?? true,
  oracle: scenario.logging?.oracle ?? true,
};

const symbolDecl = scenario.symbols[0]!;
const SYMBOL = symbolDecl.symbol;

/** ----------------------------
 *  Kernel + latency
 *  --------------------------- */
let kernel: Kernel;
const getExchangeId = () => kernel.exchangeId;

kernel = new Kernel({
  tickMs,
  latency: new TwoStageRpcLatency(getExchangeId, latency.rpcUpMs, latency.rpcDownMs, latency.computeMs, latency.downJitterMs),
});

/** ----------------------------
 *  Exchange + agents
 *  --------------------------- */
let nextId = 0;
const exch = new ExchangeAgent(nextId++, SYMBOL);
kernel.addExchange(exch);

/** helper: assign optional params to a class instance if fields exist */
function applyParams<T extends object>(obj: T, params?: Record<string, any>) {
  if (!params) return obj;
  for (const [k, v] of Object.entries(params)) {
    if (k in obj) {
      // @ts-ignore
      obj[k] = typeof v === "number" && /Ms$/.test(k) ? v * 1_000_000 /* ms→ns */ : v;
    }
  }
  return obj;
}

/** Instantiate declared agents */
for (const decl of symbolDecl.agents) {
  const count = Math.max(1, decl.count ?? 1);
  for (let i = 0; i < count; i++) {
    switch (decl.type) {
      case "MarketMaker": {
        const mm = new MarketMaker(nextId++, SYMBOL);
        const p = decl.params ?? {};

        // принимаем и ns, и ms
        if (typeof p.wakeFreqNs === "number") (mm as any).wakeFreqNs = p.wakeFreqNs;
        if (typeof p.wakeFreqMs === "number") (mm as any).wakeFreqNs = p.wakeFreqMs * 1_000_000;

        if (typeof p.levels === "number") (mm as any).levels = p.levels;
        if (typeof p.levelQty === "number") (mm as any).levelQty = p.levelQty;
        if (typeof p.baseSpread === "number") (mm as any).baseSpread = p.baseSpread;
        if (typeof p.alphaVol === "number") (mm as any).alphaVol = p.alphaVol;
        if (typeof p.stepBetweenLevels === "number") (mm as any).stepBetweenLevels = p.stepBetweenLevels;
        if (typeof p.invSkewCentsPerQty === "number") (mm as any).invSkewCentsPerQty = p.invSkewCentsPerQty;
        if (typeof p.priceHysteresisCents === "number") (mm as any).priceHysteresisCents = p.priceHysteresisCents;
        if (typeof p.maxModifiesPerWake === "number") (mm as any).maxModifiesPerWake = p.maxModifiesPerWake;
        if (typeof p.maxCancelsPerWake === "number") (mm as any).maxCancelsPerWake = p.maxCancelsPerWake;

        applyParams(mm, decl.params);
        kernel.addAgent(mm);
        break;
      }

      case "NoiseTaker": {
        const nt = new NoiseTaker(nextId++, SYMBOL);
        const p = decl.params ?? {};
        if (typeof p.freqNs === "number") (nt as any).freqNs = p.freqNs;
        if (typeof p.freqMs === "number") (nt as any).freqNs = p.freqMs * 1_000_000;
        if (typeof p.smallMaxQty === "number") (nt as any).smallMaxQty = p.smallMaxQty;
        if (typeof p.largeMinQty === "number") (nt as any).largeMinQty = p.largeMinQty;
        if (typeof p.largeMaxQty === "number") (nt as any).largeMaxQty = p.largeMaxQty;
        if (typeof p.tailProb === "number") (nt as any).tailProb = p.tailProb;
        applyParams(nt, decl.params);
        kernel.addAgent(nt);
        break;
      }

      case "TradeAgent": {
        const p = { ...(decl.params ?? {}) };
        if (typeof p.wakeFreqMs === "number") p.wakeFreqNs = p.wakeFreqMs * 1_000_000;
        if (typeof p.orderTtlMs === "number") p.orderTtlNs = p.orderTtlMs * 1_000_000;
        delete p.wakeFreqMs;
        delete p.orderTtlMs;
        const ta = new TradeAgent(nextId++, { symbol: SYMBOL, ...p });
        kernel.addAgent(ta);
        break;
      }

      case "ValueAgent": {
        const va = new ValueAgent(nextId++, { symbol: SYMBOL, ...(decl.params ?? {}) });
        kernel.addAgent(va);
        break;
      }

      case "OracleAgent": {
        const p = decl.params ?? {};
        const mode = String(p.mode ?? "JDM").toUpperCase() as "OU" | "JDM";
        const wakeNs = typeof p.wakeFreqNs === "number" ? p.wakeFreqNs : typeof p.wakeMs === "number" ? p.wakeMs * 1_000_000 : 150_000_000;

        const oracle = new OracleAgent(nextId++, {
          symbol: SYMBOL,
          mode,
          wakeFreqNs: wakeNs,
          ...(mode === "OU"
            ? {
                r0: p.r0 ?? p.ou?.r0,
                mu: p.mu ?? p.ou?.mu,
                kappa: p.kappa ?? p.ou?.kappa,
                sigmaCents: p.sigmaCents ?? p.ou?.sigma,
                lambdaAnn: p.lambdaAnn ?? p.ou?.lambda,
                jumpStdCents: p.jumpStdCents ?? p.ou?.jumpStd,
              }
            : {
                s0: p.s0 ?? p.jdm?.s0,
                muAnn: p.muAnn ?? p.jdm?.mu,
                sigmaAnn: p.sigmaAnn ?? p.jdm?.sigma,
                lambdaAnn: p.lambdaAnn ?? p.jdm?.lambda,
                muJ: p.muJ ?? p.jdm?.muJ,
                sigmaJ: p.sigmaJ ?? p.jdm?.sigmaJ,
              }),
        } as any);
        kernel.addAgent(oracle);
        break;
      }

      case "OBIAgent": {
        // добавь импорт: import { OBIAgent } from "./agents/OBIAgent";
        const obi = new OBIAgent(nextId++, { symbol: SYMBOL, ...(decl.params ?? {}) });
        kernel.addAgent(obi);
        break;
      }

      default:
        console.warn(`Unknown agent type in scenario: ${decl.type}`);
    }
  }
}

/** optional HUMAN for API sugar */
const human = new HumanTrader(nextId++, SYMBOL, "HUMAN");
kernel.addAgent(human);

/** ----------------------------
 *  Logging
 *  --------------------------- */
let ordersCsv: CsvLog | undefined;
let tradesCsv: CsvLog | undefined;
let oracleCsv: CsvLog | undefined;

if (logging.enabled) {
  if (logging.orders) {
    ordersCsv = new CsvLog(path.join(logging.dir, "orders.csv"), {
      truncate: true,
      header: ["ts", "from", "to", "msgType", "symbol", "side", "price", "qty", "orderId", "reason"],
    });
  }
  if (logging.trades) {
    tradesCsv = new CsvLog(path.join(logging.dir, "trades.csv"), {
      truncate: true,
      header: ["ts", "symbol", "price", "qty", "maker", "taker", "makerSide"],
    });
  }
  if (logging.oracle) {
    oracleCsv = new CsvLog(path.join(logging.dir, "oracle.csv"), {
      truncate: true,
      header: ["ts", "symbol", "mode", "fundamental", "drift", "diff", "jump", "mr"],
    });
  }
}

kernel.on(MsgType.ORDER_LOG, (e: any) => {
  ordersCsv?.write({
    ts: e.ts,
    from: e.from,
    to: e.to,
    msgType: e.msgType,
    symbol: e.body?.symbol,
    side: e.body?.side,
    price: e.body?.price,
    qty: e.body?.qty,
    orderId: e.body?.id,
  });
});

kernel.on(MsgType.ORDER_REJECTED, (e: any) => {
  ordersCsv?.write({
    ts: nowNs(),
    from: e.from ?? -1,
    to: e.to ?? kernel.exchangeId,
    msgType: MsgType.ORDER_REJECTED,
    symbol: e.ref?.symbol,
    side: e.ref?.side,
    price: e.ref?.price,
    qty: e.ref?.qty,
    orderId: e.ref?.id,
    reason: e.reason,
  } as any);
});

kernel.on(MsgType.TRADE, (e: any) => {
  tradesCsv?.write({
    ts: e.ts,
    symbol: e.symbol,
    price: e.price,
    qty: e.qty,
    maker: e.maker,
    taker: e.taker,
    makerSide: e.makerSide,
  });
});

kernel.on(MsgType.ORACLE_TICK, (e: any) => {
  oracleCsv?.write({
    ts: e.ts,
    symbol: e.symbol,
    mode: e.mode,
    fundamental: e.fundamental,
    drift: e.lastStep?.drift,
    diff: e.lastStep?.diff,
    jump: e.lastStep?.jump ?? e.lastStep?.jumpLog,
    mr: e.lastStep?.mr,
  });
});

/** ----------------------------
 *  Console MD (compact)
 *  --------------------------- */
let lastPrintNs = 0;
const PRINT_EVERY_NS = 120_000_000; // ~120ms, реже чем tick → меньше мерцание
const DEPTH = 20; // показываем глубже

function fmtPx(p?: number | null) {
  return p == null ? "-" : (p / 100).toFixed(2);
}
function fmtLvl(level?: [number, number]) {
  return level ? `${fmtPx(level[0])} × ${level[1]}` : "";
}

kernel.onTick = () => {
  const now = kernel.nowNs();
  if (now - lastPrintNs < PRINT_EVERY_NS) return; // throttle

  const book = kernel.getBook(SYMBOL);
  if (!book) return;
  const snap = book.snapshot(DEPTH);
  const [bestBid] = snap.bids;
  const [bestAsk] = snap.asks;
  const spread = bestBid && bestAsk ? bestAsk[0] - bestBid[0] : null;

  console.clear();
  console.log(`t=${now}  ${SYMBOL}  last=${fmtPx(snap.last)}  bid=${fmtLvl(bestBid as any)}  ask=${fmtLvl(bestAsk as any)}  spread=${spread ?? "-"}`);

  const rows = Math.max(DEPTH, snap.bids.length, snap.asks.length);
  console.log("\n   BID (price × qty)              |     ASK (price × qty)");
  for (let i = 0; i < rows; i++) {
    const b = (fmtLvl(snap.bids[i] as any) || "").padEnd(30);
    const a = fmtLvl(snap.asks[i] as any) || "";
    console.log(` ${b}|  ${a}`);
  }
  lastPrintNs = now;
};

// ----------------------------
// API + start/stop
// ----------------------------
const PORT = parseInt(String(cli.port ?? "3000"), 10);
startApi(kernel, { port: PORT, humanAgent: human });

const startNs = nowNs();
console.log(`Starting sim "${scenario.name ?? "scenario"}" for ${SYMBOL} ` + `(tick=${tickMs}ms, dur=${durationMs}ms) ` + `latency(up=${latency.rpcUpMs}ms, down=${latency.rpcDownMs}ms, compute=${latency.computeMs}ms, jitter=${latency.downJitterMs}ms) ` + `logs=${logging.enabled ? logging.dir : "off"}`);
kernel.start(startNs);

setTimeout(() => {
  kernel.stop();
  console.log("\nSimulation stopped.");
  process.exit(0);
}, durationMs);
