import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { Kernel } from "../kernel/Kernel";
import { MsgType } from "../messages/types";
import { Side } from "../util/types";

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

  // --- WS ---
  const wss = new WebSocketServer({ noServer: true });
  const server = app.server;
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/ws")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });
  const broadcast = (obj: any) => {
    const data = JSON.stringify(obj);
    wss.clients.forEach((c: any) => {
      if (c.readyState === 1) c.send(data);
    });
  };

  kernel.on(MsgType.TRADE, (ev) => broadcast({ channel: "trade", event: ev }));
  kernel.on(MsgType.ORDER_LOG, (ev) => broadcast({ channel: "order", event: ev }));
  kernel.on(MsgType.ORDER_REJECTED, (ev) => broadcast({ channel: "reject", event: ev }));

  kernel.on(MsgType.MARKET_DATA, (ev) => broadcast({ channel: "md", event: ev }));
  kernel.on(MsgType.ORACLE_TICK, (ev) => broadcast({ channel: "oracle", event: ev }));

  app.listen({ port, host: "0.0.0.0" }, () => {
    console.log(`[api] http://localhost:${port}  (WS: /ws)`);
  });

  return { app, wss };
}
