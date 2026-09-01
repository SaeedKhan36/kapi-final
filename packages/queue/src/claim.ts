import { retryDeadlockedTransaction, type DbHandle } from "@kapi/db";
import type { Job, JobKind } from "@kapi/protocol";
import { JOB_COLUMNS, toJob, type JobRow } from "./rows.ts";
import { appendEvent, jobStatusEvent } from "./events.ts";
import { leaseSeconds } from "./config.ts";

export type ClaimOptions = {
  /** The VM asking. Becomes the lease holder. */
  vmId: string;
  /** Which kinds this VM can run. Empty means any. */
  kinds?: JobKind[];
  /** Restrict to one run, or to one specific job. */
  runId?: string;
  jobId?: string;
  leaseSeconds?: number;
};

/**
 * Claims one job, atomically, for `vmId`.
 *
 * The inner SELECT ... FOR UPDATE SKIP LOCKED is the whole mechanism: N VMs can
 * poll this concurrently and each walks past rows its peers have locked instead
 * of blocking on them. No coordinator, no in-process scheduler, and a VM that
 * dies mid-job loses nothing but its lease.
 *
 * `dependsOn` is gated here rather than by a planner, because there is no plan -
 * a captain may add a dependency edge at any moment by spawning with one.
 */
export async function claim(handle: DbHandle, opts: ClaimOptions): Promise<Job | null> {
  const lease = opts.leaseSeconds ?? leaseSeconds();
  const kinds = opts.kinds ?? [];

  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `UPDATE jobs SET
         status = 'claimed',
         vm_id = $1,
         attempts = attempts + 1,
         lease_expires_at = now() + ($2::int * interval '1 second'),
         started_at = COALESCE(started_at, now())
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE j.status = 'queued'
           AND (cardinality($3::text[]) = 0 OR j.kind = ANY($3::text[]))
           AND ($4::text IS NULL OR j.run_id = $4::text)
           AND ($5::text IS NULL OR j.id = $5::text)
           AND NOT EXISTS (
             SELECT 1 FROM jobs d
             WHERE d.id = ANY(j.depends_on) AND d.status <> 'succeeded'
           )
         ORDER BY j.priority DESC, j.created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${JOB_COLUMNS}`,
      [opts.vmId, lease, kinds, opts.runId ?? null, opts.jobId ?? null],
    );

    const row = rows[0];
    if (!row) return null;

    const job = toJob(row);
    await appendEvent(
      tx,
      jobStatusEvent({
        runId: job.runId,
        jobId: job.id,
        from: "queued",
        to: "claimed",
        vmId: opts.vmId,
        attempts: job.attempts,
      }),
    );
    return job;
  });
}
