import type { DbHandle } from "@kapi/db";
import type { EventRow, Store } from "./store.ts";

export type Client = {
  id: string;
  /** Watch one run, or null for every active run. */
  runId: string | null;
  send: (data: string) => void;
};

/**
 * Fan-out of the event stream to websocket clients.
 *
 * Two delivery paths, because there are two kinds of writer:
 *
 *   1. In-process publish - the control plane writes almost every event
 *      itself (agents POST theirs to it), so that path is immediate.
 *   2. A per-run tail - anything written by another process (a reaper running
 *      elsewhere, a second control-plane instance) is picked up by polling.
 *
 * The tail cursors on `events.seq`, which is allocated under the run's row lock
 * and is therefore gap-free and strictly ordered. Tailing a global id or a
 * timestamp instead would be subject to commit-order races; per-run seq is not.
 */
export class EventHub {
  #clients = new Map<string, Client>();
  #cursors = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private handle: DbHandle,
    private pollMs = Number(process.env.KAPI_EVENT_POLL_MS ?? 1000),
  ) {}

  get clientCount() { return this.#clients.size; }

  add(client: Client): () => void {
    this.#clients.set(client.id, client);
    this.#ensurePolling();
    return () => {
      this.#clients.delete(client.id);
      if (this.#clients.size === 0) this.#stopPolling();
    };
  }

  /**
   * Replays a run's history to one client, then marks it caught up.
   * Called on connect so a reconnecting browser loses nothing.
   */
  async replay(client: Client, runId: string, afterSeq = 0): Promise<number> {
    const events = await this.store.listEvents(runId, afterSeq);
    for (const e of events) client.send(JSON.stringify({ kind: "event", event: e }));
    const last = events.at(-1)?.seq ?? afterSeq;
    // Never move a shared cursor backwards - another client may be further along.
    this.#cursors.set(runId, Math.max(this.#cursors.get(runId) ?? 0, last));
    client.send(JSON.stringify({ kind: "replayed", runId, cursor: last, count: events.length }));
    return last;
  }

  /** Immediate delivery for an event this process just committed. */
  publish(event: EventRow): void {
    this.#cursors.set(event.runId, Math.max(this.#cursors.get(event.runId) ?? 0, event.seq));
    this.#fanOut(event);
  }

  #fanOut(event: EventRow) {
    const frame = JSON.stringify({ kind: "event", event });
    for (const client of this.#clients.values()) {
      if (client.runId === null || client.runId === event.runId) {
        try { client.send(frame); } catch { this.#clients.delete(client.id); }
      }
    }
  }

  #ensurePolling() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), this.pollMs);
    this.#timer.unref?.();
  }

  #stopPolling() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick() {
    const runIds = await this.#watchedRuns();
    for (const runId of runIds) {
      try {
        const since = this.#cursors.get(runId) ?? 0;
        const events = await this.store.listEvents(runId, since, 200);
        if (events.length === 0) continue;
        this.#cursors.set(runId, events.at(-1)!.seq);
        for (const e of events) this.#fanOut(e);
      } catch {
        // Transient. The next tick re-reads from the same cursor, and throwing
        // here would take down the process hosting the hub.
      }
    }
  }

  /**
   * Runs worth polling: those explicitly watched, plus every non-terminal run
   * when someone is watching globally. Bounded either way - a dashboard cannot
   * make this scan the whole history.
   */
  async #watchedRuns(): Promise<string[]> {
    const explicit = new Set<string>();
    let global = false;
    for (const c of this.#clients.values()) {
      if (c.runId) explicit.add(c.runId);
      else global = true;
    }

    if (global) {
      const rows = await this.handle.raw<{ id: string }>(
        `SELECT id FROM runs WHERE status NOT IN ('completed','failed','cancelled')
         ORDER BY created_at DESC LIMIT 50`,
      );
      for (const r of rows) explicit.add(r.id);
    }
    return [...explicit];
  }

  close() {
    this.#stopPolling();
    this.#clients.clear();
  }
}
