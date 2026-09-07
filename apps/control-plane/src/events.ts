import type { DbHandle } from "@kapi/db";
import type { EventRow, Store } from "./store.ts";

export type Client = {
  id: string;
  /** Watch one run, or null for every active run. */
  runId: string | null;
  send: (data: string) => void;
};

type ClientState = {
  client: Client;
  cursors: Map<string, number>;
  replaying: Set<string>;
  buffered: Map<string, Map<number, EventRow>>;
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
  #clients = new Map<string, ClientState>();
  #cursors = new Map<string, number>();
  #buffered = new Map<string, Map<number, EventRow>>();
  #drains = new Map<string, Promise<void>>();
  #dirty = new Set<string>();
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
    this.#clients.set(client.id, {
      client,
      cursors: new Map(),
      replaying: new Set(client.runId ? [client.runId] : []),
      buffered: new Map(),
    });
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
    const state = this.#clients.get(client.id);
    if (!state) throw new Error("event client is not registered");
    state.replaying.add(runId);
    state.cursors.set(runId, afterSeq);

    let count = 0;
    let after = afterSeq;
    for (;;) {
      const events = await this.store.listEvents(runId, after, 1000);
      for (const event of events) if (this.#sendNow(state, event)) count++;
      after = events.at(-1)?.seq ?? after;
      if (events.length < 1000) break;
    }

    // Events committed while history was loading were held for this client.
    // Drain those buffers before making it live; JavaScript executes the empty
    // check and replaying.delete synchronously, so there is no handoff gap.
    for (;;) {
      const pending = state.buffered.get(runId);
      if (!pending?.size) {
        state.buffered.delete(runId);
        state.replaying.delete(runId);
        break;
      }
      state.buffered.delete(runId);
      for (const event of [...pending.values()].sort((a, b) => a.seq - b.seq)) {
        if (this.#sendNow(state, event)) count++;
      }
    }

    const last = state.cursors.get(runId) ?? afterSeq;
    client.send(JSON.stringify({ kind: "replayed", runId, cursor: last, count }));
    return last;
  }

  /** Immediate delivery for an event this process just committed. */
  publish(event: EventRow): void {
    this.#ingest(event);
  }

  async #notified(payload: string) {
    if (this.#closed) return;
    try {
      const parsed = JSON.parse(payload) as { runId?: string; seq?: number };
      if (!parsed.runId || !Number.isFinite(parsed.seq)) return;
      if ((parsed.seq ?? 0) <= (this.#cursors.get(parsed.runId) ?? 0)) return;
      await this.#requestDrain(parsed.runId);
    } catch { /* polling remains the recovery path */ }
  }

  #ingest(event: EventRow) {
    const cursor = this.#cursors.get(event.runId) ?? 0;
    if (event.seq <= cursor) return;
    if (event.seq !== cursor + 1) {
      const pending = this.#buffered.get(event.runId) ?? new Map<number, EventRow>();
      pending.set(event.seq, event);
      this.#buffered.set(event.runId, pending);
      this.#track(this.#requestDrain(event.runId));
      return;
    }

    this.#advance(event);
    const pending = this.#buffered.get(event.runId);
    while (pending) {
      const next = pending.get((this.#cursors.get(event.runId) ?? 0) + 1);
      if (!next) break;
      pending.delete(next.seq);
      this.#advance(next);
    }
    if (pending?.size === 0) this.#buffered.delete(event.runId);
  }

  #advance(event: EventRow) {
    this.#buffered.get(event.runId)?.delete(event.seq);
    this.#cursors.set(event.runId, event.seq);
    this.#fanOut(event);
  }

  #fanOut(event: EventRow) {
    const frame = JSON.stringify({ kind: "event", event });
    for (const state of this.#clients.values()) {
      const { client } = state;
      if (client.runId === null || client.runId === event.runId) {
        if (state.replaying.has(event.runId)) {
          const pending = state.buffered.get(event.runId) ?? new Map<number, EventRow>();
          pending.set(event.seq, event);
          state.buffered.set(event.runId, pending);
        } else {
          this.#sendNow(state, event, frame);
        }
      }
    }
  }

  #sendNow(state: ClientState, event: EventRow, frame?: string): boolean {
    if (event.seq <= (state.cursors.get(event.runId) ?? 0)) return false;
    try {
      state.client.send(frame ?? JSON.stringify({ kind: "event", event }));
      state.cursors.set(event.runId, event.seq);
      return true;
    } catch {
      this.#clients.delete(state.client.id);
      return false;
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
      try { await this.#requestDrain(runId); }
      catch { /* transient; the next poll resumes from the same cursor */ }
    }
  }

  #requestDrain(runId: string): Promise<void> {
    this.#dirty.add(runId);
    const active = this.#drains.get(runId);
    if (active) return active;

    const drain = (async () => {
      while (this.#dirty.delete(runId)) {
        for (;;) {
          const since = this.#cursors.get(runId) ?? 0;
          const events = await this.store.listEvents(runId, since, 200);
          for (const event of events) this.#ingest(event);
          if (events.length < 200) break;
        }
      }
    })().finally(() => {
      this.#drains.delete(runId);
      if (this.#dirty.has(runId) && !this.#closed) this.#track(this.#requestDrain(runId));
    });
    this.#drains.set(runId, drain);
    return drain;
  }

  /**
   * Runs worth polling: those explicitly watched, plus every non-terminal run
   * when someone is watching globally. Bounded either way - a dashboard cannot
   * make this scan the whole history.
   */
  async #watchedRuns(): Promise<string[]> {
    const explicit = new Set<string>();
    let global = false;
    for (const { client } of this.#clients.values()) {
      if (client.runId) explicit.add(client.runId);
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
