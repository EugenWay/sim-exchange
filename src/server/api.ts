import Fastify from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import { Kernel } from "../kernel/Kernel";
import { MsgType } from "../messages/types";
import { Side } from "../util/types";

type ClientSubscription = {
  ws: WebSocket;
  channels: Set<string>;
  symbols: Set<string>;
};

export function startApi(kernel: Kernel, opts: { port?: number; humanAgent?: any } = {}) {
  const app = Fastify();
  const port = opts.port ?? 3000;
  const human = opts.humanAgent;

  app.get("/book/:symbol", (_req, reply) => {
    const symbol = (_req.params as any).symbol;
    const snap = kernel.getBook(symbol)?.snapshot(20);
    reply.send(snap ?? {});
  });

  app.get("/balances", (_req, reply) => {
    reply.send(human?.getBalances() ?? {});
  });

  app.get("/orders", (_req, reply) => {
    if (!human) return reply.send([]);
    reply.send(human.listOpen());
  });

  app.post<{ Body: { type: "LIMIT" | "MARKET"; symbol: string; side: Side; price?: number; qty: number } }>("/order", async (req, reply) => {
    const { type, symbol, side, price, qty } = req.body;
    if (!human) return reply.code(400).send({ error: "human agent not configured" });
    if (symbol !== human.symbol) return reply.code(400).send({ error: "symbol mismatch" });

    if (type === "LIMIT") {
      if (typeof price !== "number") return reply.code(400).send({ error: "price required" });
      const id = human.placeLimit(price, qty, side);
      return reply.send({ ok: true, id });
    } else {
      human.placeMarket(qty, side);
      return reply.send({ ok: true });
    }
  });

  app.patch<{ Params: { id: string }; Body: { price?: number; qty?: number } }>("/order/:id", async (req, reply) => {
    if (!human) return reply.code(400).send({ error: "human agent not configured" });
    const { id } = req.params;
    const { price, qty } = req.body ?? {};
    human.modify(id, { price, qty });
    reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>("/order/:id", async (req, reply) => {
    if (!human) return reply.code(400).send({ error: "human agent not configured" });
    const { id } = req.params;
    human.cancel(id);
    reply.send({ ok: true });
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = app.server;
  const clients = new Map<WebSocket, ClientSubscription>();

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/ws")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    clients.set(ws, { ws, channels: new Set(), symbols: new Set() });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleClientMessage(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ error: "invalid message" }));
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.send(JSON.stringify({ type: "connected" }));
  });

  function handleClientMessage(ws: WebSocket, msg: any) {
    const client = clients.get(ws);
    if (!client) return;

    if (msg.type === "subscribe") {
      const { channel, symbol } = msg;
      if (channel) client.channels.add(channel);
      if (symbol) client.symbols.add(symbol);
      ws.send(JSON.stringify({ type: "subscribed", channel, symbol }));
    } else if (msg.type === "unsubscribe") {
      const { channel, symbol } = msg;
      if (channel) client.channels.delete(channel);
      if (symbol) client.symbols.delete(symbol);
      ws.send(JSON.stringify({ type: "unsubscribed", channel, symbol }));
    }
  }

  function broadcast(channel: string, event: any) {
    const data = JSON.stringify({ channel, event });
    clients.forEach((client) => {
      if (client.ws.readyState === 1 && client.channels.has(channel)) {
        const symbol = event.symbol;
        if (!symbol || client.symbols.size === 0 || client.symbols.has(symbol)) {
          client.ws.send(data);
        }
      }
    });
  }

  const bookThrottle = new Map<string, { timer?: NodeJS.Timeout; pending?: any }>();

  function broadcastBook(symbol: string, snapshot: any) {
    const key = symbol;
    const state = bookThrottle.get(key) || {};

    state.pending = snapshot;

    if (!state.timer) {
      state.timer = setTimeout(() => {
        if (state.pending) {
          broadcast("book", { symbol, ...state.pending });
          state.pending = undefined;
        }
        state.timer = undefined;
      }, 100);
      bookThrottle.set(key, state);
    }
  }

  kernel.on(MsgType.TRADE, (ev) => broadcast("trade", ev));
  kernel.on(MsgType.ORDER_LOG, (ev) => broadcast("order", ev));
  kernel.on(MsgType.ORDER_REJECTED, (ev) => broadcast("reject", ev));
  kernel.on(MsgType.ORACLE_TICK, (ev) => broadcast("oracle", ev));

  kernel.on(MsgType.MARKET_DATA, (ev) => {
    broadcast("md", ev);
    if (ev.symbol) {
      broadcastBook(ev.symbol, { bids: ev.bids, asks: ev.asks, last: ev.last });
    }
  });

  app.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`[api] http://localhost:${port}  (WS: /ws)`);
  });

  return { app, wss };
}
