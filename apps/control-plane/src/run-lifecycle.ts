import { retryDeadlockedTransaction, type DbHandle } from "@kapi/db";
import { isJobTerminal, type Job } from "@kapi/protocol";
import { appendEvent, jobStatusEvent } from "@kapi/queue";
import type { Store } from "./store.ts";

/**
 * The one place `runs.status` changes.
 *
 * A run's lifecycle is a control-plane concept, not a queue one: `completed`
 * and `cancelled` are words `packages/queue` has no vocabulary for, and the
 * queue deliberately knows nothing about threads or the messages a finished run
 * writes into them. So the queue reports facts - this module decides what a
 * fact means for the run that contains it.
 *
 * It takes no `EventHub`. Every caller either flushes the run's new events
 * itself or must deliberately let the hub's tail deliver them; publishing from
 * in here would make that choice invisible, and one of the two callers cannot
 * safely publish at all (see `onReap`).
 *
 * Terminal transitions use guarded updates rather than read-then-write. The
 * row lock serialises competing completion/cancellation paths, and a cancelled
 * run holds that same lock while closing all work so a concurrent spawn wakes
 * up, observes the terminal state, and creates nothing.
 */
export type RunLifecycle = ReturnType<typeof createRunLifecycle>;

export function createRunLifecycle(deps: { handle: DbHandle; store: Store }) {
  const { handle, store } = deps;

  /**
   * A run is running once any of its agents is.
   *
   * Any job, not just the root captain. For the first transition the two are
   * the same thing - children exist only because the root already started - but
   * a root that loses its lease goes back to `queued` while its children keep
   * working, and that run is still running by any honest reading.
   *
   * Returns the appended sequence number, or null when the run was already past
   * `queued` and nothing was written.
   */
  const startRun = async (runId: string, jobId: string): Promise<number | null> =>
    handle.transaction(async (tx) => {
      // Guarded rather than unconditional: this fires on EVERY agent start, so
      // it must announce the transition exactly once, and it must never walk a
      // run that has already finished or been cancelled back to running.
      const claimed = await tx<{ id: string }>(
        `UPDATE runs SET status = 'running' WHERE id = $1 AND status = 'queued' RETURNING id`,
        [runId],
      );
      if (claimed.length === 0) return null;

      return appendEvent(tx, {
        runId, jobId, kind: "run.status", from: "orchestrator",
        payload: { status: "running" },
      });
    });

  /**
   * A run ends when its ROOT captain does, and the captain's closing summary is
   * written back into the thread as a turn.
   *
   * The thread is the human-facing half of a run. Everything the fleet says
   * lives in `events`, which is machine trace - without this the user can only
   * ever talk into a thread and never be answered in it.
   *
   * Only a TERMINAL root counts: `fail` requeues while attempts remain, and a
   * run that announces itself failed and then carries on is worse than one that
   * says nothing. Callers own that check; `onReap` below is the example.
   *
   * Returns the appended sequence number, or null when the run had already
   * reached a terminal status and this call did nothing.
   */
  const finishRun = async (job: Job): Promise<number | null> =>
    handle.transaction(async (tx) => {
      const status = job.status === "succeeded" ? "completed" : "failed";
      const summary = job.result?.summary ?? job.error ?? `the captain ${job.status}`;

      // A root captain is the owner of every branch beneath it. Once it exits,
      // no descendant can produce a result that will still be consumed, so
      // keeping queued or leased children alive only burns VM time. Take job
      // locks before the run lock used by appendEvent, matching queue lifecycle
      // transactions and avoiding a jobs<->runs deadlock with a finishing child.
      const cancelled = await tx<{ id: string }>(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM jobs WHERE parent_job_id = $1
           UNION ALL
           SELECT j.id FROM jobs j JOIN descendants d ON j.parent_job_id = d.id
         )
         UPDATE jobs SET status = 'cancelled', lease_expires_at = NULL,
                         finished_at = now(), error = 'root captain finished'
         WHERE id IN (SELECT id FROM descendants)
           AND status NOT IN ('succeeded','failed','cancelled')
           AND EXISTS (
             SELECT 1 FROM runs WHERE id = $2
               AND status NOT IN ('completed','failed','cancelled')
           )
         RETURNING id`,
        [job.id, job.runId],
      );
      const cancelledIds = cancelled.map((row) => row.id).sort();
      if (cancelledIds.length > 0) {
        await tx(
          `UPDATE agents SET status = 'cancelled', stopped_at = now()
           WHERE job_id = ANY($1::text[]) AND stopped_at IS NULL`,
          [cancelledIds],
        );
        for (const jobId of cancelledIds) {
          await appendEvent(tx, jobStatusEvent({
            runId: job.runId, jobId, to: "cancelled",
            detail: "root captain finished",
          }));
        }
      }

      // Claims the run and reads its thread in one statement. Zero rows means
      // someone else finished it first, which makes double-finishing - two
      // closing turns in one thread - impossible rather than merely unlikely.
      const claimed = await tx<{ thread_id: string; schedule_id: string | null }>(
        `UPDATE runs SET status = $2, error = COALESCE($3, error), finished_at = now()
         WHERE id = $1 AND status NOT IN ('completed','failed','cancelled')
         RETURNING thread_id, schedule_id`,
        [job.runId, status, job.error ?? null],
      );
      const threadId = claimed[0]?.thread_id;
      if (!threadId) return null;

      await store.createMessageIn(tx, {
        threadId, role: "captain", content: summary, runId: job.runId,
      });
      if (claimed[0]?.schedule_id) {
        await tx(
          `UPDATE schedules SET last_status=$2, last_error=$3, updated_at=now() WHERE id=$1`,
          [claimed[0].schedule_id, status, job.error ?? null],
        );
      }

      return appendEvent(tx, {
        runId: job.runId, jobId: job.id, kind: "run.status", from: "orchestrator",
        payload: { status, summary },
      });
    });

  /** Cancels a run and all of its work as one durable state transition. */
  const cancelRun = async (runId: string, reason = "cancelled by user"): Promise<number> =>
    retryDeadlockedTransaction(handle, async (tx) => {
      // Lock and close the run first. A concurrent spawn request uses this same
      // row as its mutex and, once it wakes, will see `cancelled` and refuse to
      // create work. Queue transitions take the opposite lock order, so this
      // transaction is explicitly deadlock-retried by the shared DB helper.
      const claimed = await tx<{ schedule_id: string | null }>(
        `UPDATE runs SET status='cancelled', error=COALESCE(error,$2), finished_at=now()
         WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')
         RETURNING schedule_id`,
        [runId, reason],
      );
      if (claimed.length === 0) return 0;

      const rows = await tx<{ id: string }>(
        `UPDATE jobs SET status='cancelled', lease_expires_at=NULL,
                         finished_at=now(), error=$2
         WHERE run_id=$1 AND status NOT IN ('succeeded','failed','cancelled')
         RETURNING id`,
        [runId, reason],
      );
      const jobIds = rows.map((row) => row.id).sort();
      if (jobIds.length > 0) {
        await tx(
          `UPDATE agents SET status='cancelled', stopped_at=now()
           WHERE job_id=ANY($1::text[]) AND stopped_at IS NULL`,
          [jobIds],
        );
        for (const jobId of jobIds) {
          await appendEvent(tx, jobStatusEvent({
            runId, jobId, to: "cancelled", detail: reason,
          }));
        }
      }
      if (claimed[0]?.schedule_id) {
        await tx(
          `UPDATE schedules SET last_status='cancelled', last_error=$2, updated_at=now()
           WHERE id=$1`,
          [claimed[0].schedule_id, reason],
        );
      }
      await appendEvent(tx, {
        runId, kind: "run.status", from: "orchestrator",
        payload: { status: "cancelled", summary: reason },
      });
      return jobIds.length;
    });

  /**
   * The reaper's adapter: finish any run whose ROOT captain was just dead-lettered.
   *
   * Without this a run outlives the agent that was driving it. The reaper takes
   * the lease back and marks the job failed, but it has no idea a run exists, so
   * the run sits at its current status with a null `finished_at` forever - a
   * live-looking run in the UI that nothing will ever resolve. That is the exact
   * failure this architecture claims to survive.
   *
   * `reap` returns requeued and dead-lettered jobs in one batch, distinguished
   * only by their new status, so `isJobTerminal` is load-bearing here: a root
   * with attempts left comes back `queued` and must NOT finish its run. It is
   * the same predicate `/agent/complete` uses, deliberately, so the two paths
   * cannot drift apart.
   */
  const onReap = async (jobs: Job[]): Promise<void> => {
    for (const job of jobs) {
      if (job.parentJobId !== null || !isJobTerminal(job.status)) continue;
      try {
        await finishRun(job);
      } catch (err) {
        // One wedged run must not stop the rest of the batch: `reap` is global
        // and a single tick can return jobs from many runs at once.
        console.error(`[run-lifecycle] could not finish run ${job.runId}:`, err);
      }
    }
  };

  return { startRun, finishRun, cancelRun, onReap };
}
