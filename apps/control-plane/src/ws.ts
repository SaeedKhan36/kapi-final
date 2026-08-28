import { WebSocketServer } from "ws";
import { newId } from "@kapi/protocol";
import type { EventHub } from "./events.ts";

/**
 * Live stream. `?runId=` scopes to one run, `?cursor=` resumes from a sequence
 * number so a reconnecting browser loses nothing in between.
 *
 * Read-only and currently unauthenticated: it carries the same data the REST
 * routes do, and threading session auth through the socket handshake belongs
 * with the UI work. Not to be exposed publicly before then.
 */
export function attachWebSocket(server: unknown, hub: EventHub): WebSocketServer {
  const wss = new WebSocketServer({ server: server as never, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const runId = url.searchParams.get("runId");
    const raw = Number(url.searchParams.get("cursor") ?? 0);
    const cursor = Number.isFinite(raw) && raw > 0 ? raw : 0;

    const client = { id: newId("ws"), runId, send: (data: string) => socket.send(data) };
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
