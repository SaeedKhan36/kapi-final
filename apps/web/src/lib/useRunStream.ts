import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "./types.ts";
import { apiBase } from "./api.ts";

/**
 * Live run feed. Reconnects with backoff, because a run outlives any single
 * socket and the browser should not need a refresh to keep watching.
 */
export function useRunStream(runId: string | null, onEvent: (e: RunEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const target = apiBase
        ? `${apiBase.replace(/^http/, "ws")}/ws?runId=${encodeURIComponent(runId)}`
        : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?runId=${encodeURIComponent(runId)}`;
      socket = new WebSocket(target);

      socket.onopen = () => { retry = 0; setConnected(true); };
      socket.onmessage = (ev) => {
        try { handler.current(JSON.parse(ev.data) as RunEvent); } catch { /* ignore malformed frame */ }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [runId]);

  return connected;
}
