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
import { ScenarioOracle } from "./agents/ScenarioOracle";
import { WhaleAgent } from "./agents/WhaleAgent";

import { startApi } from "./server/api";
import { CsvLog } from "./util/csvlog";
import { MsgType } from "./messages/types";
import { nowNs } from "./util/time";

/* ============================
 * Types
 * ============================ */

type AgentDecl = {
  type: "MarketMaker" | "NoiseTaker" | "TradeAgent" | "OracleAgent" | "ValueAgent" | "OBIAgent" | "ScenarioOracle" | "WhaleAgent";
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

/* ============================
 * CLI
 * ============================ */

const program = new Command();
program.option("-c, --config <file>", "scenario JSON path", "scenarios/jump-demo.json").option("--dur <ms>", "override durationMs").option("--tick <ms>", "override tickMs").option("--port <n>", "HTTP port", "3000").option("--log-dir <path>", "override log dir").option("--no-logs", "disable all logs");

program.parse();
const cli = program.opts();

/* ============================
 * Scenario load / normalize
 * ============================ */

function loadScenario(p: string): Scenario {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(raw) as Scenario;

  if (!json.symbols || json.symbols.length === 0) {
    throw new Error("Scenario must contain at least one symbol.");
  }
  // текущий Kernel поддерживает только один exchangeId → 1 символ
  if (json.symbols.length > 1) {
    throw new Error("Current Kernel supports one exchange (one symbol) per run. Provide exactly one item in symbols[].");
  }
  return json;
}

const scenario = loadScenario(cli.config);

// CLI-overrides
if (cli.dur) scenario.durationMs = parseInt(cli.dur, 10);
if (cli.tick) scenario.tickMs = parseInt(cli.tick, 10);
if (cli.logs === false) scenario.logging = { ...(scenario.logging ?? {}), enabled: false };
if (cli.logDir) scenario.logging = { ...(scenario.logging ?? {}), dir: String(cli.logDir) };

/* ============================
 * Effective settings
 * ============================ */

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

/* ============================
 * Kernel + Exchange
 * ============================ */

let kernel: Kernel;
const getExchangeId = () => kernel.exchangeId;

kernel = new Kernel({
  tickMs,
  latency: new TwoStageRpcLatency(getExchangeId, latency.rpcUpMs, latency.rpcDownMs, latency.computeMs, latency.downJitterMs),
});

let nextId = 0;
const exch = new ExchangeAgent(nextId++, SYMBOL);
kernel.addExchange(exch);

/* ============================
 * Helpers
 * ============================ */

// Присвоение параметров агентам, auto-конверт *Ms → ns по имени поля
function applyParams<T extends object>(obj: T, params?: Record<string, any>) {
  if (!params) return obj;
  for (const [k, v] of Object.entries(params)) {
    if (k in (obj as any)) {
      (obj as any)[k] = typeof v === "number" && /Ms$/.test(k) ? v * 1_000_000 : v;
    }
  }
  return obj;
}

// Нормализатор wake/order TTL для агентов, принимающих *Ms
function msNsPatch(p: any, fields: Array<[msKey: string, nsKey: string]>) {
  const copy = { ...(p ?? {}) };
  for (const [msKey, nsKey] of fields) {
    if (typeof copy[msKey] === "number") {
      copy[nsKey] = copy[msKey] * 1_000_000;
      delete copy[msKey];
    }
  }
  return copy;
}

/* ============================
 * Agents instantiation
 * ============================ */

for (const decl of symbolDecl.agents) {
  const count = Math.max(1, decl.count ?? 1);

  for (let i = 0; i < count; i++) {
    const p = decl.params ?? {};

    switch (decl.type) {
      case "MarketMaker": {
        const mm = new MarketMaker(nextId++, SYMBOL);

        // допуски: wakeFreqNs / wakeFreqMs + базовые поля
        if (typeof p.wakeFreqNs === "number") (mm as any).wakeFreqNs = p.wakeFreqNs;
        if (typeof p.wakeFreqMs === "number") (mm as any).wakeFreqNs = p.wakeFreqMs * 1_000_000;

        for (const k of ["levels", "levelQty", "baseSpread", "alphaVol", "stepBetweenLevels", "invSkewCentsPerQty", "priceHysteresisCents", "maxModifiesPerWake", "maxCancelsPerWake"]) {
          if (typeof p[k] === "number") (mm as any)[k] = p[k];
        }

        applyParams(mm, p);
        kernel.addAgent(mm);
        break;
      }

      case "NoiseTaker": {
        const nt = new NoiseTaker(nextId++, SYMBOL);

        if (typeof p.freqNs === "number") (nt as any).freqNs = p.freqNs;
        if (typeof p.freqMs === "number") (nt as any).freqNs = p.freqMs * 1_000_000;

        for (const k of ["smallMaxQty", "largeMinQty", "largeMaxQty", "tailProb"]) {
          if (typeof p[k] === "number") (nt as any)[k] = p[k];
        }

        applyParams(nt, p);
        kernel.addAgent(nt);
        break;
      }

      case "TradeAgent": {
        const pn = msNsPatch(p, [
          ["wakeFreqMs", "wakeFreqNs"],
          ["orderTtlMs", "orderTtlNs"],
        ]);
        const ta = new TradeAgent(nextId++, { symbol: SYMBOL, ...pn });
        kernel.addAgent(ta);
        break;
      }

      case "ValueAgent": {
        const va = new ValueAgent(nextId++, { symbol: SYMBOL, ...p });
        kernel.addAgent(va);
        break;
      }

      case "OracleAgent": {
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
        const obi = new OBIAgent(nextId++, { symbol: SYMBOL, ...p });
        kernel.addAgent(obi);
        break;
      }

      case "ScenarioOracle": {
        const wakeNs = typeof p.wakeFreqNs === "number" ? p.wakeFreqNs : typeof p.wakeFreqMs === "number" ? p.wakeFreqMs * 1_000_000 : 150_000_000;

        const oracle = new ScenarioOracle(nextId++, {
          symbol: SYMBOL,
          scenario: p.scenario,
          wakeFreqNs: wakeNs,
          noiseScale: p.noiseScale ?? 0.4,
        });
        kernel.addAgent(oracle);
        break;
      }

      case "WhaleAgent": {
        const wakeNs = typeof p.wakeFreqNs === "number" ? p.wakeFreqNs : typeof p.wakeFreqMs === "number" ? p.wakeFreqMs * 1_000_000 : 250_000_000;

        const whale = new WhaleAgent(nextId++, {
          symbol: SYMBOL,
          strategy: p.strategy,
          targetQty: p.targetQty,
          periodSec: p.periodSec,
          pumpQty: p.pumpQty,
          pumpDurationSec: p.pumpDurationSec,
          dumpDurationSec: p.dumpDurationSec,
          schedule: p.schedule,
          aggression: p.aggression,
          wakeFreqNs: wakeNs,
        });
        kernel.addAgent(whale);
        break;
      }

      default:
        console.warn(`Unknown agent type in scenario: ${decl.type}`);
    }
  }
}

/* ============================
 * Human (для API)
 * ============================ */

const human = new HumanTrader(nextId++, SYMBOL, "HUMAN");
kernel.addAgent(human);

/* ============================
 * Logging
 * ============================ */

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
      header: ["ts", "symbol", "fundamental", "target", "elapsedSec", "mode", "drift", "diff", "jump", "mr"],
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
  const drift = e.lastStep?.drift;
  const diff = e.lastStep?.diff;
  const jump = e.lastStep?.jump ?? e.lastStep?.jumpLog;
  const mr = e.lastStep?.mr;

  oracleCsv?.write({
    ts: e.ts,
    symbol: e.symbol,
    fundamental: e.fundamental,
    target: e.target,
    elapsedSec: e.elapsedSec,
    mode: e.mode,
    drift,
    diff,
    jump,
    mr,
  });
});

/* ============================
 * Console rendering (кадровый, буферизованный)
 * ============================ */

const DEPTH = 20;
const RENDER_EVERY_MS = Math.max(tickMs, 120); // не чаще ~8 Гц и не чаще тика

let prevKey = "";
let lastPrintedAt = 0; // ms since epoch
let renderTimer: NodeJS.Timeout | null = null;
let dirty = true; // хотя бы один тик прошёл — нужен рендер

// Позволяет принудительно выводить кадры в non-TTY (например, в CI).
const FORCE_NON_TTY_RENDER = process.env.FORCE_NON_TTY_RENDER === "1";

function fmtPx(p?: number | null) {
  return p == null ? "-" : (p / 100).toFixed(2);
}
function fmtLvl(level?: [number, number]) {
  return level ? `${fmtPx(level[0])} × ${level[1]}` : "";
}

function clearAndHome() {
  if (process.stdout.isTTY) {
    // спрятать курсор; очистить скроллбэк + экран; курсор в (0,0)
    process.stdout.write("\x1b[?25l\x1b[3J\x1b[2J\x1b[H");
  }
}

function buildFrame(nowNs: number): { out: string; key: string } | null {
  const book = kernel.getBook(SYMBOL);
  if (!book) return null;

  const snap = book.snapshot(DEPTH);
  const [bb] = snap.bids;
  const [ba] = snap.asks;

  const key = `${snap.last}|${bb?.[0]}|${bb?.[1]}|${ba?.[0]}|${ba?.[1]}`;

  const spread = bb && ba ? ba[0] - bb[0] : null;

  let out = "";
  out += `t=${nowNs}  ${SYMBOL}  last=${fmtPx(snap.last)}  ` + `bid=${fmtLvl(bb as any)}  ask=${fmtLvl(ba as any)}  spread=${spread ?? "-"}\n`;

  const rows = Math.min(DEPTH, Math.max(snap.bids.length, snap.asks.length));
  if (rows > 0) {
    out += `\n   BID (price × qty)              |     ASK (price × qty)\n`;
    for (let i = 0; i < rows; i++) {
      const b = (fmtLvl(snap.bids[i] as any) || "").padEnd(30);
      const a = fmtLvl(snap.asks[i] as any) || "";
      out += ` ${b}|  ${a}\n`;
    }
  }

  return { out, key };
}

function renderOnce() {
  const nowNs = kernel.nowNs();
  const frame = buildFrame(nowNs);
  if (!frame) return;

  // если состояние не изменилось — ничего не рисуем
  if (frame.key === prevKey) return;
  prevKey = frame.key;

  if (process.stdout.isTTY) {
    clearAndHome();
    process.stdout.write(frame.out);
  } else if (FORCE_NON_TTY_RENDER) {
    // non-TTY: выводим редко и только по флагу
    const nowMs = Date.now();
    if (nowMs - lastPrintedAt >= 1000) {
      lastPrintedAt = nowMs;
      process.stdout.write(frame.out + "\n");
    }
  } else {
    // non-TTY без флага — не печатаем кадры, чтобы не засорять логи
  }
}

function ensureRenderLoop() {
  if (renderTimer) return;
  renderTimer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    renderOnce();
  }, RENDER_EVERY_MS);
}

// помечаем «грязным» на каждом тике, рендер-петля сама оттроттлит вывод
kernel.onTick = () => {
  dirty = true;
  ensureRenderLoop();
};

/* ============================
 * API + lifecycle
 * ============================ */

const PORT = parseInt(String(cli.port ?? "3000"), 10);
startApi(kernel, { port: PORT, humanAgent: human });

const startNs = nowNs();
console.log(`Starting sim "${scenario.name ?? "scenario"}" for ${SYMBOL} ` + `(tick=${tickMs}ms, dur=${durationMs}ms) ` + `latency(up=${latency.rpcUpMs}ms, down=${latency.rpcDownMs}ms, compute=${latency.computeMs}ms, jitter=${latency.downJitterMs}ms) ` + `logs=${logging.enabled ? logging.dir : "off"}`);
kernel.start(startNs);
ensureRenderLoop();

function stopAll(reason = "Simulation stopped.") {
  try {
    if (renderTimer) clearInterval(renderTimer);
    kernel.stop();
  } catch {}
  // вернуть курсор перед выходом
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
  console.log(`\n${reason}`);
  process.exit(0);
}

setTimeout(() => stopAll(), durationMs);

process.on("SIGINT", () => stopAll("Interrupted (SIGINT)."));
process.on("SIGTERM", () => stopAll("Terminated (SIGTERM)."));
