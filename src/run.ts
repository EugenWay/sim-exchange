import { Command } from "commander";
import { Kernel } from "./kernel/Kernel";
import { ExchangeAgent } from "./agents/ExchangeAgent";
import { MarketMaker } from "./agents/MarketMaker";
import { NoiseTaker } from "./agents/NoiseTaker";
import { HumanTrader } from "./agents/HumanTrader";
import { TradeAgent } from "./agents/TradeAgent";
import { nowNs, fromNow } from "./util/time";
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
  .option("--down-jitter <ms>", "down jitter ms", "0");

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

// время
const start = nowNs();
const stop = fromNow(DURATION_MS);

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

// TradeAgents (простые трендфолловеры + пассивные котировки)
for (let i = 0; i < TA_N; i++) {
  kernel.addAgent(
    new TradeAgent(nextId++, {
      symbol: SYMBOL,
      // можно не трогать — есть дефолты:
      // wakeFreqNs: 120_000_000,
      // shortPeriod: 8,
      // longPeriod: 21,
      // thresholdBp: 6,
      // signalQty: 25,
      // passiveLevels: 2,
      // passiveStep: 25,
      // passiveQty: 50,
      // orderTtlNs: 1_000_000_000,
      // maxPosition: 5_000,
    })
  );
}

const HUMAN_ID = nextId;
const human = new HumanTrader(HUMAN_ID, SYMBOL, "HUMAN");
kernel.addAgent(human);

const ordersCsv = new CsvLog(`${LOG_DIR}/orders.csv`, {
  truncate: true,
  header: ["ts", "from", "to", "msgType", "symbol", "side", "price", "qty", "orderId"],
});

const tradesCsv = new CsvLog(`${LOG_DIR}/trades.csv`, {
  truncate: true,
  header: ["ts", "symbol", "price", "qty", "maker", "taker", "makerSide"],
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

console.log(`Starting sim for ${SYMBOL} with ${MM_N} MM, ${NOISE_N} noise, ${TA_N} TA ` + `(tick=${TICK_MS}ms, dur=${DURATION_MS}ms, up=${RPC_UP}ms, down=${RPC_DOWN}ms, compute=${COMPUTE}ms, jitter=${DOWN_JITTER}ms)`);
kernel.start(start);

setTimeout(() => {
  kernel.stop();
  console.log("\nSimulation stopped.");
  process.exit(0);
}, DURATION_MS);
