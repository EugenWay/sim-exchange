import { PriorityQueue } from "./PriorityQueue";
import { Message, MsgType } from "../messages/types";
import { OrderBook } from "../orderbook/OrderBook";
import type { LatencyModel } from "./LatencyModel";

type AgentObj = {
  id: number;
  name: string;
  attachKernel: (k: Kernel) => void;
  kernelStarting: (t: number) => void;
  kernelStopping: () => void;
  receive: (t: number, m: Message) => void;
  wakeup: (t: number) => void;
};

const NS_PER_MS = 1_000_000;

type Listener = (ev: { type: string; [k: string]: any }) => void;

export class Kernel {
  private q = new PriorityQueue<Message>();
  private agents: AgentObj[] = [];
  private timeNs = 0;
  private wallTickMs: number;
  private timer?: NodeJS.Timeout;
  private books = new Map<string, OrderBook>();

  public exchangeId!: number;

  public onTick?: (tNs: number) => void;

  private listeners: Map<string, Set<Listener>> = new Map();

  private latency: LatencyModel | undefined;

  constructor(opts: { tickMs?: number; latency?: LatencyModel | undefined } = {}) {
    this.wallTickMs = opts.tickMs ?? 200;
    this.latency = opts.latency;
  }

  setLatency(l: LatencyModel) {
    this.latency = l;
  }

  on(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  off(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(ev: { type: string; [k: string]: any }) {
    this.listeners.get(ev.type)?.forEach((fn) => fn(ev));
  }

  addAgent(a: AgentObj) {
    a.attachKernel(this);
    this.agents.push(a);
  }

  addExchange(e: AgentObj & { book: OrderBook }) {
    this.exchangeId = e.id;
    this.books.set(e.book.symbol, e.book);
    this.addAgent(e);
  }

  getBook(symbol: string) {
    return this.books.get(symbol);
  }

  nowNs() {
    return this.timeNs;
  }

  send(from: number, to: number, type: MsgType, body?: any, delayNs = 0) {
    const compute = to === this.exchangeId && from !== this.exchangeId ? this.latency?.computeNs?.(to) ?? 0 : 0;

    const net = this.latency?.delayNs(from, to) ?? 0;

    this.q.push({ from, to, type, body, at: this.nowNs() + net + compute + delayNs });

    if (type === MsgType.LIMIT_ORDER || type === MsgType.MARKET_ORDER || type === MsgType.CANCEL_ORDER || type === MsgType.MODIFY_ORDER) {
      this.emit({ type: MsgType.ORDER_LOG, ts: this.nowNs(), from, to, msgType: type, body });
    }
  }

  wakeup(agentId: number, atNs: number) {
    this.q.push({ from: -1, to: agentId, type: MsgType.WAKEUP, at: atNs });
  }

  broadcast(type: MsgType, body: any, extraDelayNs = 0) {
    const from = this.exchangeId;
    for (const a of this.agents) {
      const to = a.id;
      if (to === from) continue;
      const net = this.latency?.delayNs(from, to) ?? 0;
      this.q.push({ from, to, type, body, at: this.nowNs() + net + extraDelayNs });
    }
  }

  start(startNs = 0) {
    this.timeNs = startNs;
    this.agents.forEach((a) => a.kernelStarting(this.timeNs));
    this.timer = setInterval(() => this.tick(), this.wallTickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.agents.forEach((a) => a.kernelStopping());
  }

  private deliver(m: Message) {
    const a = this.agents.find((x) => x.id === m.to);
    if (!a) return;
    if (m.type === MsgType.WAKEUP) a.wakeup(this.timeNs);
    else a.receive(this.timeNs, m);
  }

  private tick() {
    this.timeNs += this.wallTickMs * NS_PER_MS;

    while (this.q.length && this.q.peek()!.at <= this.timeNs) {
      const m = this.q.pop()!;
      this.deliver(m);
    }

    this.onTick?.(this.timeNs);
  }
}
