#!/usr/bin/env node
import { Command } from "commander";
import { Kernel } from "./kernel/Kernel";
import { ExchangeAgent } from "./agents/ExchangeAgent";
import { MarketMaker } from "./agents/MarketMaker";
import { NoiseTaker } from "./agents/NoiseTaker";
import { HumanTrader } from "./agents/HumanTrader";
import { nowNs, fromNow } from "./util/time";
import { CsvLog } from "./util/csvlog";
import { MsgType } from "./messages/types";
import { startApi } from "./server/api";

const program = new Command();
program.option("-s, --symbol <sym>", "symbol", "BTC-USDT").option("--dur <ms>", "duration in ms", "60000").option("--tick <ms>", "tick interval in ms", "200").option("--mm <n>", "market makers", "3").option("--noise <n>", "noise takers", "10").option("--port <n>", "http port", "3000").option("--log-dir <path>", "csv log dir", "./logs");
program.parse();
const opts = program.opts();

const SYMBOL = String(opts.symbol);
const DURATION_MS = parseInt(opts.dur, 10);
const TICK_MS = parseInt(opts.tick, 10);
const MM_N = parseInt(opts.mm, 10);
const NOISE_N = parseInt(opts.noise, 10);
const PORT = parseInt(opts.port, 10);
const LOG_DIR = String(opts.logDir);

// время
const start = nowNs();
const stop = fromNow(DURATION_MS);

// ядро
const kernel = new Kernel({ tickMs: TICK_MS });

// биржа
const exch = new ExchangeAgent(0, SYMBOL);
kernel.addExchange(exch);

// агенты
for (let i = 0; i < MM_N; i++) kernel.addAgent(new MarketMaker(1 + i, SYMBOL));
for (let i = 0; i < NOISE_N; i++) kernel.addAgent(new NoiseTaker(1 + MM_N + i, SYMBOL));
const HUMAN_ID = 1 + MM_N + NOISE_N;
const human = new HumanTrader(HUMAN_ID, SYMBOL, "HUMAN");
kernel.addAgent(human);

// CSV-логгеры
const ordersCsv = new CsvLog(`${LOG_DIR}/orders.csv`);
const tradesCsv = new CsvLog(`${LOG_DIR}/trades.csv`);

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

// живой вывод стакана раз в тик + пуш маркет-даты по WS (не слишком часто)
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
  console.log(`t=${kernel.nowNs()}  ${SYMBOL}  last=${fmtPx(snap.last)}  bid=${fmtLvl(bestBid as any)}  ask=${fmtLvl(bestAsk as any)}  spread=${spread ?? "-"}`);
  console.log("\n   BID (price × qty)         |     ASK (price × qty)");
  const rows = Math.max(DEPTH, snap.bids.length, snap.asks.length);
  for (let i = 0; i < rows; i++) {
    const b = (fmtLvl(snap.bids[i] as any) || "").padEnd(26);
    const a = fmtLvl(snap.asks[i] as any) || "";
    console.log(` ${b}|  ${a}`);
  }

  // пушим MARKET_DATA через kernel.emit, чтобы WS поднял
  const json = JSON.stringify({ type: "md", symbol: SYMBOL, ...snap });
  if (json !== lastSnapJson) {
    kernel.emit({ type: MsgType.MARKET_DATA, symbol: SYMBOL, ...snap });
    lastSnapJson = json;
  }
};

// API/WS
startApi(kernel, { port: PORT, humanAgent: human });

// запуск
console.log(`Starting sim for ${SYMBOL} with ${MM_N} MM & ${NOISE_N} noise takers (tick=${TICK_MS}ms, dur=${DURATION_MS}ms)`);
kernel.start(start);

// авто-стоп
setTimeout(() => {
  kernel.stop();
  console.log("\nSimulation stopped.");
  process.exit(0);
}, DURATION_MS);
