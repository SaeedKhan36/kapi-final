import { WebSocketServer } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { newId } from "@kapi/protocol";
import type { Authenticator } from "@kapi/identity";
import type { EventHub } from "./events.ts";
import type { Store } from "./store.ts";
import { isAllowedBrowserOrigin } from "./config.ts";

/**
 * Live stream. `?runId=` scopes to one run, `?cursor=` resumes from a sequence
 * number so a reconnecting browser loses nothing in between.
 *
 * The HTTP upgrade authenticates the session and checks run ownership before
 * any history can be replayed. Browsers send the HttpOnly AuthKit cookie with
 * the upgrade, so tokens never appear in a websocket URL.
 */
export function attachWebSocket(
  server: unknown, hub: EventHub, deps: { auth: Authenticator; store: Store },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  (server as HttpServer).on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return reject(socket, 404, "not found");
      if(hub.clientCount>=Number(process.env.KAPI_MAX_WS_CLIENTS??1000))return reject(socket,503,"websocket capacity reached");
      const origin = req.headers.origin;
      if (origin && !isAllowedBrowserOrigin(origin)) return reject(socket, 403, "origin not allowed");
      let principal;
      try { principal = await deps.auth.authenticate(req.headers.authorization, req.headers.cookie); }
      catch { return reject(socket, 401, "unauthenticated"); }
      const runId = url.searchParams.get("runId");
      if (!runId && deps.auth.mode !== "dev") return reject(socket, 400, "runId is required");
      if (runId && await deps.store.runOwner(runId) !== principal.userId) {
        return reject(socket, 404, "run not found");
      }
      // Recheck after asynchronous authentication/ownership reads, immediately before registration.
      if(hub.clientCount>=Number(process.env.KAPI_MAX_WS_CLIENTS??1000))return reject(socket,503,"websocket capacity reached");
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    })().catch(() => reject(socket, 500, "upgrade failed"));
  });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const runId = url.searchParams.get("runId");
    const raw = Number(url.searchParams.get("cursor") ?? 0);
    const cursor = Number.isFinite(raw) && raw > 0 ? raw : 0;

    const client = { id: newId("ws"), runId, close:()=>socket.close(1013,"replay buffer full; reconnect with cursor"), send: (data: string) => {
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "client too slow; reconnect with cursor"); return; }
      if (socket.readyState === socket.OPEN) socket.send(data);
    } };
    const remove = hub.add(client);
    socket.on("close", remove);
    socket.on("error", remove);

    if (runId) {
      void hub.replay(client, runId, cursor)
        .catch(() => socket.send(JSON.stringify({ kind: "error", error: "replay failed" })));
    } else {
      socket.send(JSON.stringify({ kind: "ready", runId: null }));
    }
  });

  return wss;
}

function reject(socket: Duplex, status: number, message: string) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
