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
  #notificationStop: (() => Promise<void>) | null = null;
  #notificationReady: Promise<void>;
  #closed = false;
  #pending = new Set<Promise<unknown>>();

  constructor(
    private store: Store,
    private handle: DbHandle,
    private pollMs = Number(process.env.KAPI_EVENT_POLL_MS ?? 1000),
  ) {
    const listen = this.handle.listen?.(
      "kapi_events",
      (payload) => this.#track(this.#notified(payload)),
    );
    // LISTEN establishes a dedicated connection asynchronously. Keep that
    // setup promise in the shutdown barrier as well as the notification work:
    // otherwise a fast test/process shutdown can close the pool while LISTEN
    // is still being written, surfacing a spurious CONNECTION_ENDED rejection.
    this.#notificationReady = listen
      ? listen
          .then(async (stop) => {
            if (this.#closed) await stop();
            else this.#notificationStop = stop;
          })
          .catch(() => {})
      : Promise.resolve();
  }

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
    if (event.seq <= (this.#cursors.get(event.runId) ?? 0)) return;
    this.#cursors.set(event.runId, Math.max(this.#cursors.get(event.runId) ?? 0, event.seq));
    this.#fanOut(event);
  }

  async #notified(payload: string) {
    if (this.#closed) return;
    try {
      const parsed = JSON.parse(payload) as { runId?: string; seq?: number };
      if (!parsed.runId || !Number.isFinite(parsed.seq)) return;
      if ((parsed.seq ?? 0) <= (this.#cursors.get(parsed.runId) ?? 0)) return;
      const rows = await this.store.listEvents(parsed.runId, (parsed.seq ?? 1) - 1, 1);
      if (rows[0]) this.publish(rows[0]);
    } catch { /* polling remains the recovery path */ }
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
    this.#timer = setInterval(() => this.#track(this.#tick()), this.pollMs);
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

  async close() {
    this.#closed = true;
    this.#stopPolling();
    this.#clients.clear();
    await this.#notificationReady;
    await this.#notificationStop?.().catch(() => {});
    this.#notificationStop = null;
    await Promise.allSettled([...this.#pending]);
  }

  #track(promise: Promise<unknown>) {
    this.#pending.add(promise);
    void promise.finally(() => this.#pending.delete(promise)).catch(() => {});
  }
}
