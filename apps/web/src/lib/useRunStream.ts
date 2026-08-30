import { useEffect, useRef, useState } from "react";
import type { RunEvent, StreamFrame } from "./types.ts";

/**
 * The live run feed, resumed from a cursor.
 *
 * A run outlives any single socket - a laptop sleeps, a proxy times out, the
 * plane restarts - so this reconnects with backoff and reconnects *from the
 * last sequence number it saw*. The plane replays everything after that cursor
 * before going live again, which is what makes a dropped connection invisible
 * rather than a hole in the middle of the agent tree.
 *
 * `events.seq` is allocated under the run's row lock, so it is gap-free and
 * strictly ordered. That is the only reason a single number is a sufficient
 * resume point; a timestamp or a global id would be subject to commit races.
 */
export function useRunStream(
  runId: string | null,
  cursor: { current: number },
  onEvent: (event: RunEvent) => void,
): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) {
      setConnected(false);
      return;
    }

    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${location.host}/ws` +
        `?runId=${encodeURIComponent(runId)}&cursor=${cursor.current}`;
      socket = new WebSocket(url);

      socket.onopen = () => { retry = 0; setConnected(true); };

      socket.onmessage = (ev) => {
        let frame: StreamFrame;
        try {
          frame = JSON.parse(ev.data as string) as StreamFrame;
        } catch {
          return; // A malformed frame is not worth tearing the socket down for.
        }
        if (frame.kind !== "event") return;

        // The replay boundary is inclusive of nothing, but a reconnect that
        // races an in-flight publish can still repeat one. Ordering by seq
        // makes both duplicates and out-of-order delivery a comparison.
        if (frame.event.seq <= cursor.current) return;
        cursor.current = frame.event.seq;
        handler.current(frame.event);
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(8_000, 500 * 2 ** retry++));
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [runId, cursor]);

  return connected;
}
