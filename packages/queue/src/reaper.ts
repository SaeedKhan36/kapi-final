import { retryDeadlockedTransaction, type DbHandle } from "@kapi/db";
import type { Job } from "@kapi/protocol";
import { JOB_COLUMNS, toJob, type JobRow } from "./rows.ts";
import { appendEvent, jobStatusEvent } from "./events.ts";

/**
 * Requeues jobs whose lease expired.
 *
 * This is what makes the whole architecture survivable. kapi-old ran every task
 * inside one in-process loop, so losing the orchestrator lost the run. Here a
 * VM can be destroyed, lose the network, or hang, and its work returns to the
 * queue for someone else - without any component having noticed the failure.
 *
 * Safe to run from several processes at once: SKIP LOCKED means two reapers
 * take disjoint sets rather than fighting over the same rows.
 */
export async function reap(handle: DbHandle, limit = 100): Promise<Job[]> {
  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `UPDATE jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         vm_id  = CASE WHEN attempts >= max_attempts THEN vm_id ELSE NULL END,
         lease_expires_at = NULL,
         error = 'lease expired: vm ' || COALESCE(vm_id, '?') || ' stopped heartbeating',
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
       WHERE id IN (
         SELECT j.id FROM jobs j
         WHERE j.status IN ('claimed','running')
           AND j.lease_expires_at IS NOT NULL
           AND j.lease_expires_at < now()
         ORDER BY j.lease_expires_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${JOB_COLUMNS}`,
      [limit],
    );

    const reaped = rows.map(toJob);
    // Keep every queue mutation on jobs -> agents -> runs/events. Updating all
    // agents before allocating any event sequence avoids the inverse ordering
    // that used to deadlock with usage accounting.
    for (const job of reaped) {
      await tx(
        `UPDATE agents SET status = $2, stopped_at = now() WHERE job_id = $1`,
        [job.id, job.status === "failed" ? "failed" : "evicted"],
      );
    }
    for (const job of [...reaped].sort((a, b) =>
      a.runId.localeCompare(b.runId) || a.id.localeCompare(b.id))) {
      await appendEvent(tx, jobStatusEvent({
        runId: job.runId,
        jobId: job.id,
        to: job.status,
        attempts: job.attempts,
        detail: job.error ?? "lease expired",
      }));
    }
    return reaped;
  });
}

/** Runs `reap` on an interval. Returns a stop function. */
export function startReaper(
  handle: DbHandle,
  // The hook may be async: the control plane uses it to finish a run whose root
  // captain was just dead-lettered, which is several statements against the DB.
  opts: { intervalMs?: number; onReap?: (jobs: Job[]) => void | Promise<void> } = {},
): () => void {
  const interval = opts.intervalMs ?? 15_000;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const jobs = await reap(handle);
      // Awaited so a slow hook delays the next tick rather than racing it on
      // the same run. Still inside the try below - a throwing hook is a reap
      // that failed, not a process that dies.
      if (jobs.length > 0) await opts.onReap?.(jobs);
    } catch {
      // A reap failure is transient by nature - the next tick retries, and
      // throwing here would take down whatever process hosts the reaper.
    }
  };

  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
