import { Command } from "commander";
import { Kernel } from "./kernel/Kernel";
import { ExchangeAgent } from "./agents/ExchangeAgent";
import { MarketMaker } from "./agents/MarketMaker";
import { NoiseTaker } from "./agents/NoiseTaker";
import { HumanTrader } from "./agents/HumanTrader";
import { TradeAgent } from "./agents/TradeAgent";
import { OracleAgent } from "./agents/OracleAgent";
import { nowNs } from "./util/time";
import { CsvLog } from "./util/csvlog";
import { MsgType } from "./messages/types";
import { startApi } from "./server/api";
import { TwoStageRpcLatency } from "./kernel/LatencyModel";

const program = new Command();
program
  .option("-s, --symbol <sym>", "symbol", "BTC-USDT")
  .option("--dur <ms>", "duration in ms", "60000")
  .option("--tick <ms>", "tick interval in ms", "200")
  .option("--mm <n>", "market makers", "3")
  .option("--noise <n>", "noise takers", "10")
  .option("--ta <n>", "trend/trade agents", "2")
  .option("--port <n>", "http port", "3000")
  .option("--log-dir <path>", "csv log dir", "./logs")
  // latency knobs
  .option("--rpc-up <ms>", "rpc up ms", "200")
  .option("--rpc-down <ms>", "rpc down ms", "200")
  .option("--compute <ms>", "compute ms (at exchange)", "300")
  .option("--down-jitter <ms>", "down jitter ms", "0")
  // oracle knobs
  .option("--oracle", "enable oracle agent", false)
  .option("--oracle-mode <m>", "OU|JDM", "JDM")
  .option("--oracle-dt <ms>", "oracle tick ms", "100")
  // OU params
  .option("--ou-r0 <cents>", "OU initial fundamental", "")
  .option("--ou-mu <cents>", "OU long-run mean", "")
  .option("--ou-kappa <per_s>", "OU mean reversion speed", "0.02")
  .option("--ou-sigma <cents_per_sqrt_s>", "OU diffusion scale", "30")
  .option("--ou-lambda <per_year>", "OU jump intensity (per year)", "0.05")
  .option("--ou-jump-std <cents>", "OU jump std (cents)", "200")
  // JDM params
  .option("--jdm-s0 <cents>", "JDM initial price", "")
  .option("--jdm-mu <per_year>", "JDM drift", "0.00")
  .option("--jdm-sigma <per_sqrt_year>", "JDM vol", "0.60")
  .option("--jdm-lambda <per_year>", "JDM jump intensity", "0.10")
  .option("--jdm-muJ <log_mean>", "JDM log jump mean", "-0.20")
  .option("--jdm-sigmaJ <log_std>", "JDM log jump std", "0.10");

program.parse();
const opts = program.opts();

const SYMBOL = String(opts.symbol);
const DURATION_MS = parseInt(opts.dur, 10);
const TICK_MS = parseInt(opts.tick, 10);
const MM_N = parseInt(opts.mm, 10);
const NOISE_N = parseInt(opts.noise, 10);
const TA_N = parseInt(opts.ta, 10);
const PORT = parseInt(opts.port, 10);
const LOG_DIR = String(opts.logDir);

const RPC_UP = parseInt(opts.rpcUp, 10);
const RPC_DOWN = parseInt(opts.rpcDown, 10);
const COMPUTE = parseInt(opts.compute, 10);
const DOWN_JITTER = parseInt(opts.downJitter, 10);

const start = nowNs();

let kernel: Kernel;
const getExchangeId = () => kernel.exchangeId;

kernel = new Kernel({
  tickMs: TICK_MS,
  latency: new TwoStageRpcLatency(getExchangeId, RPC_UP, RPC_DOWN, COMPUTE, DOWN_JITTER),
});

const exch = new ExchangeAgent(0, SYMBOL);
kernel.addExchange(exch);

for (let i = 0; i < MM_N; i++) kernel.addAgent(new MarketMaker(1 + i, SYMBOL));
for (let i = 0; i < NOISE_N; i++) kernel.addAgent(new NoiseTaker(1 + MM_N + i, SYMBOL));

let nextId = 1 + MM_N + NOISE_N;

for (let i = 0; i < TA_N; i++) {
  kernel.addAgent(
    new TradeAgent(nextId++, {
      symbol: SYMBOL,
    })
  );
}

const ORACLE_ON = !!opts.oracle;
if (ORACLE_ON) {
  const mode = String(opts.oracleMode || "JDM").toUpperCase() as "OU" | "JDM";
  const dtNs = parseInt(opts.oracleDt, 10) * 1_000_000;

  const oracle =
    mode === "OU"
      ? new OracleAgent(nextId++, {
          symbol: SYMBOL,
          mode,
          wakeFreqNs: dtNs,
          r0: opts.ouR0 ? parseInt(opts.ouR0, 10) : undefined,
          mu: opts.ouMu ? parseInt(opts.ouMu, 10) : undefined,
          kappa: parseFloat(opts.ouKappa),
          sigmaCents: parseFloat(opts.ouSigma),
          lambdaAnn: parseFloat(opts.ouLambda),
          jumpStdCents: parseFloat(opts.ouJumpStd),
        } as any)
      : new OracleAgent(nextId++, {
          symbol: SYMBOL,
          mode,
          wakeFreqNs: dtNs,
          s0: opts.jdmS0 ? parseInt(opts.jdmS0, 10) : undefined,
          muAnn: parseFloat(opts.jdmMu),
          sigmaAnn: parseFloat(opts.jdmSigma),
          lambdaAnn: parseFloat(opts.jdmLambda),
          muJ: parseFloat(opts.jdmMuJ),
          sigmaJ: parseFloat(opts.jdmSigmaJ),
        } as any);

  kernel.addAgent(oracle);
}

const HUMAN_ID = nextId;
const human = new HumanTrader(HUMAN_ID, SYMBOL, "HUMAN");
kernel.addAgent(human);

const ordersCsv = new CsvLog(`${LOG_DIR}/orders.csv`, {
  truncate: true,
  header: ["ts", "from", "to", "msgType", "symbol", "side", "price", "qty", "orderId", "reason"],
});

const tradesCsv = new CsvLog(`${LOG_DIR}/trades.csv`, {
  truncate: true,
  header: ["ts", "symbol", "price", "qty", "maker", "taker", "makerSide"],
});

const oracleCsv = new CsvLog(`${LOG_DIR}/oracle.csv`, {
  truncate: true,
  header: ["ts", "symbol", "mode", "fundamental", "drift", "diff", "jump", "mr"],
});

kernel.on(MsgType.ORDER_LOG, (e) => {
  ordersCsv.write({
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

kernel.on(MsgType.TRADE, (e) => {
  tradesCsv.write({
    ts: e.ts,
    symbol: e.symbol,
    price: e.price,
    qty: e.qty,
    maker: e.maker,
    taker: e.taker,
    makerSide: e.makerSide,
  });
});

kernel.on(MsgType.ORDER_REJECTED, (e: any) => {
  ordersCsv.write({
    ts: kernel.nowNs(),
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

kernel.on(MsgType.ORACLE_TICK, (e: any) => {
  oracleCsv.write({
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

const DEPTH = 5;
function fmtPx(p: number | null | undefined) {
  return p == null ? "-" : (p / 100).toFixed(2);
}
function fmtLvl(level?: [number, number]) {
  return level ? `${fmtPx(level[0])} × ${level[1]}` : "";
}

let lastSnapJson = "";
kernel.onTick = () => {
  const book = kernel.getBook(SYMBOL);
  if (!book) return;

  const snap = book.snapshot(DEPTH);
  const [bestBid] = snap.bids;
  const [bestAsk] = snap.asks;
  const spread = bestBid && bestAsk ? bestAsk[0] - bestBid[0] : null;

  console.clear();
  console.log(`t=${kernel.nowNs()}  ${SYMBOL}  last=${fmtPx(snap.last)}  ` + `bid=${fmtLvl(bestBid as any)}  ask=${fmtLvl(bestAsk as any)}  spread=${spread ?? "-"}`);
  console.log("\n   BID (price × qty)         |     ASK (price × qty)");
  const rows = Math.max(DEPTH, snap.bids.length, snap.asks.length);
  for (let i = 0; i < rows; i++) {
    const b = (fmtLvl(snap.bids[i] as any) || "").padEnd(26);
    const a = fmtLvl(snap.asks[i] as any) || "";
    console.log(` ${b}|  ${a}`);
  }

  const json = JSON.stringify({ type: "md", symbol: SYMBOL, ...snap });
  if (json !== lastSnapJson) {
    kernel.emit({ type: MsgType.MARKET_DATA, symbol: SYMBOL, ...snap });
    lastSnapJson = json;
  }
};

startApi(kernel, { port: PORT, humanAgent: human });

console.log(`Starting sim for ${SYMBOL} with ${MM_N} MM, ${NOISE_N} noise, ${TA_N} TA` + ` (tick=${TICK_MS}ms, dur=${DURATION_MS}ms, up=${RPC_UP}ms, down=${RPC_DOWN}ms, compute=${COMPUTE}ms, jitter=${DOWN_JITTER}ms` + `, oracle=${ORACLE_ON ? opts.oracleMode : "off"})`);

kernel.start(start);

setTimeout(() => {
  kernel.stop();
  console.log("\nSimulation stopped.");
  process.exit(0);
}, DURATION_MS);
