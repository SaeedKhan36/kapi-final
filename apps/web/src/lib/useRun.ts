import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import {
  applyEvent, emptyRunState, mergeJobResult, seedFromJobs, type RunState,
} from "./agents.ts";
import { useRunStream } from "./useRunStream.ts";
import type { Run, RunEvent } from "./types.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (status: string): boolean => TERMINAL.has(status);

/** One page of `/api/runs/:id/events`. Matches the plane's own default limit. */
const PAGE = 1000;

/**
 * A run, its agent tree, and the live stream feeding both.
 *
 * History is read through the same cursor the socket resumes from, so there is
 * exactly one ordering to reason about: page `?after=` until the history runs
 * out, then hand that cursor to the websocket and let it carry on from there.
 * Nothing is fetched twice and nothing between the last page and the socket
 * opening can slip through the gap.
 */
export function useRun(runId: string | null) {
  const [run, setRun] = useState<Run | null>(null);
  const [state, setState] = useState<RunState>(() => emptyRunState());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    cursor.current = 0;
    setRun(null);
    setState(emptyRunState());
    setError(null);
    if (!runId) return;

    let dropped = false;
    setLoading(true);

    void (async () => {
      try {
        const detail = await api.getRun(runId);
        if (dropped) return;
        setRun(detail.run);

        let next = seedFromJobs(detail.jobs, detail.run.status);
        let page = detail.events;
        let after = page.at(-1)?.seq ?? 0;

        for (;;) {
          for (const event of page) next = applyEvent(next, event);
          if (page.length < PAGE) break;
          page = await api.runEvents(runId, after);
          if (dropped) return;
          after = page.at(-1)?.seq ?? after;
        }

        cursor.current = after;
        setState(next);
      } catch (err) {
        if (!dropped) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!dropped) setLoading(false);
      }
    })();

    return () => { dropped = true; };
  }, [runId]);

  // One enrichment per job per terminal status, so a retried job that fails
  // twice is read twice and a chatty stream never is.
  const enriched = useRef(new Set<string>());
  useEffect(() => { enriched.current = new Set(); }, [runId]);

  const onEvent = useCallback((event: RunEvent) => {
    setState((prev) => applyEvent(prev, event));

    if (event.kind !== "job.status" || !event.jobId) return;
    const status = event.payload.status;
    if (status !== "succeeded" && status !== "failed") return;

    const key = `${event.jobId}:${status}`;
    if (enriched.current.has(key)) return;
    enriched.current.add(key);
    void api.getJob(event.jobId)
      .then((job) => setState((prev) => mergeJobResult(prev, job)))
      .catch(() => {});
  }, []);

  const connected = useRunStream(runId, cursor, onEvent);

  // The run row carries counters the event stream does not - llm calls, tokens,
  // spend. Re-read once the run stops rather than polling: while it is running
  // the tree is the interesting thing, and /api/runs/:id is not a cheap read.
  useEffect(() => {
    if (!runId || !isTerminal(state.status)) return;
    let dropped = false;
    void api.getRun(runId)
      .then((detail) => { if (!dropped) setRun(detail.run); })
      .catch(() => {});
    return () => { dropped = true; };
  }, [runId, state.status]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    await api.cancelRun(runId);
  }, [runId]);

  return { run, state, connected, loading, error, cancel };
}
