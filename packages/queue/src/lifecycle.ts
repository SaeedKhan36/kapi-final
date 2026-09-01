import { retryDeadlockedTransaction, type DbHandle, type SqlRunner } from "@kapi/db";
import {
  JobSpecSchema, newId, type Job, type JobResult, type JobSpec,
} from "@kapi/protocol";
import { JOB_COLUMNS, toJob, type JobRow } from "./rows.ts";
import { appendEvent, jobStatusEvent } from "./events.ts";
import { defaultMaxAttempts, leaseSeconds } from "./config.ts";

const LEASED = `('claimed','running')`;

/**
 * Retries a query once when the connection died underneath it.
 *
 * Pooled Postgres (Neon in particular) recycles idle connections, so a query
 * can fail with CONNECTION_CLOSED through no fault of its own. These queue
 * operations are single statements and safe to repeat; a lost connection must
 * not look like a lost job.
 */
async function retryOnClosed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/CONNECTION_CLOSED|CONNECTION_ENDED|ECONNRESET|Connection terminated/i.test(message)) {
      throw err;
    }
    return fn();
  }
}

/** Adds a job. This is what a captain's `spawn_agents` tool ultimately calls. */
export async function enqueue(handle: DbHandle, spec: JobSpec): Promise<Job> {
  return retryDeadlockedTransaction(handle, (tx) => enqueueIn(tx, spec));
}

/** Transactional form used when opening a run and its root job atomically. */
export async function enqueueIn(tx: SqlRunner, spec: JobSpec): Promise<Job> {
  const s = JobSpecSchema.parse(spec);
  const id = newId("job");

  const rows = await tx<JobRow>(
      `INSERT INTO jobs
         (id, run_id, parent_job_id, kind, role, status, payload,
          max_attempts, priority, depends_on)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9::text[])
       RETURNING ${JOB_COLUMNS}`,
      [
        id, s.runId, s.parentJobId ?? null, s.kind, s.role,
        JSON.stringify({
          instruction: s.instruction,
          acceptance: s.acceptance,
          touches: s.touches,
          ...(s.vmSpec ? { vmSpec: s.vmSpec } : {}),
          context: s.context,
        }),
        s.maxAttempts ?? defaultMaxAttempts(),
        s.priority,
        s.dependsOn,
      ],
    );

  const job = toJob(rows[0]!);
  await appendEvent(tx, jobStatusEvent({ runId: job.runId, jobId: job.id, to: "queued" }));
  await tx(`UPDATE runs SET total_spawns = total_spawns + 1 WHERE id = $1`, [job.runId]);
  return job;
}

/**
 * Extends the lease. Returns FALSE when the lease is gone rather than throwing.
 *
 * That is the whole contract with an agent: a VM whose lease the reaper took
 * back must discover it and stop, or two VMs end up pushing the same branch.
 * A thrown error is easy to swallow in a polling loop; a false is not.
 */
export async function heartbeat(
  handle: DbHandle, jobId: string, vmId: string, seconds = leaseSeconds(),
): Promise<boolean> {
  // Retried because it is idempotent: it extends a lease and creates nothing.
  // `claim`, `complete` and `fail` do not retry ambiguous connection failures:
  // a first attempt may have committed. They only retry PostgreSQL 40P01,
  // whose contract guarantees the whole transaction was rolled back.
  const rows = await retryOnClosed(() => handle.raw<{ id: string }>(
    `UPDATE jobs SET lease_expires_at = now() + ($3::int * interval '1 second')
     WHERE id = $1 AND vm_id = $2 AND status IN ${LEASED}
     RETURNING id`,
    [jobId, vmId, seconds],
  ));
  if (rows.length === 0) return false;
  await handle.raw(
    `UPDATE agents SET last_heartbeat = now() WHERE job_id = $1 AND vm_id = $2`,
    [jobId, vmId],
  );
  return true;
}

/** claimed -> running, once the agent has actually started work. */
export async function markRunning(
  handle: DbHandle, jobId: string, vmId: string,
): Promise<Job | null> {
  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `UPDATE jobs SET status = 'running'
       WHERE id = $1 AND vm_id = $2 AND status = 'claimed'
       RETURNING ${JOB_COLUMNS}`,
      [jobId, vmId],
    );
    const row = rows[0];
    if (!row) return null;
    const job = toJob(row);
    await appendEvent(tx, jobStatusEvent({
      runId: job.runId, jobId: job.id, from: "claimed", to: "running", vmId,
    }));
    return job;
  });
}

/** Finishes a job successfully. Null when the caller no longer holds the lease. */
export async function complete(
  handle: DbHandle, jobId: string, vmId: string, result: JobResult,
): Promise<Job | null> {
  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `UPDATE jobs SET status = 'succeeded', result = $3, error = NULL,
                      lease_expires_at = NULL, finished_at = now()
       WHERE id = $1 AND vm_id = $2 AND status IN ${LEASED}
       RETURNING ${JOB_COLUMNS}`,
      [jobId, vmId, JSON.stringify(result)],
    );
    const row = rows[0];
    if (!row) return null;
    const job = toJob(row);
    // Queue lock order is jobs -> agents -> runs/events. Accounting also takes
    // agents before runs, so this ordering cannot form a cycle with it.
    await stopAgent(tx, jobId, "succeeded");
    await appendEvent(tx, jobStatusEvent({
      runId: job.runId, jobId: job.id, to: "succeeded", vmId, detail: result.summary,
    }));
    return job;
  });
}

/**
 * Reports a failure. Requeues while attempts remain, terminates when they run
 * out. Attempts were already incremented at claim time, so `maxAttempts` counts
 * claims, not retries after the first.
 */
export async function fail(
  handle: DbHandle, jobId: string, vmId: string, error: string,
): Promise<Job | null> {
  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `UPDATE jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         vm_id  = CASE WHEN attempts >= max_attempts THEN vm_id ELSE NULL END,
         lease_expires_at = NULL,
         error = $3,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
       WHERE id = $1 AND vm_id = $2 AND status IN ${LEASED}
       RETURNING ${JOB_COLUMNS}`,
      [jobId, vmId, error],
    );
    const row = rows[0];
    if (!row) return null;
    const job = toJob(row);
    // Same reasoning as the reaper: requeued or dead-lettered, this VM is done
    // with the job, so its agent row must not look live to the provisioner.
    await stopAgent(tx, jobId, job.status === "failed" ? "failed" : "retrying");
    await appendEvent(tx, jobStatusEvent({
      runId: job.runId, jobId: job.id, to: job.status, vmId,
      attempts: job.attempts, detail: error,
    }));
    return job;
  });
}

/**
 * Cancels a job and every descendant. Backs a captain's `cancel_agent` tool:
 * abandoning a line of work must abandon whatever that work spawned, or those
 * children keep burning VMs for a result nobody will read.
 */
export async function cancelSubtree(
  handle: DbHandle, jobId: string, reason = "cancelled by parent",
): Promise<Job[]> {
  return retryDeadlockedTransaction(handle, async (tx) => {
    const rows = await tx<JobRow>(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM jobs WHERE id = $1
         UNION ALL
         SELECT j.id FROM jobs j JOIN subtree s ON j.parent_job_id = s.id
       )
       UPDATE jobs SET status = 'cancelled', lease_expires_at = NULL,
                       finished_at = now(), error = $2
       WHERE id IN (SELECT id FROM subtree)
         AND status NOT IN ('succeeded','failed','cancelled')
       RETURNING ${JOB_COLUMNS}`,
      [jobId, reason],
    );

    const cancelled = rows.map(toJob);
    if (cancelled.length > 0) {
      await tx(
        `UPDATE agents SET status = 'cancelled', stopped_at = now()
         WHERE job_id = ANY($1::text[])`,
        [cancelled.map((job) => job.id)],
      );
    }
    for (const job of [...cancelled].sort((a, b) =>
      a.runId.localeCompare(b.runId) || a.id.localeCompare(b.id))) {
      await appendEvent(tx, jobStatusEvent({
        runId: job.runId, jobId: job.id, to: "cancelled", detail: reason,
      }));
    }
    return cancelled;
  });
}

async function stopAgent(
  tx: (sql: string, params?: unknown[]) => Promise<unknown[]>,
  jobId: string, status: string,
) {
  await tx(
    `UPDATE agents SET status = $2, stopped_at = now() WHERE job_id = $1`,
    [jobId, status],
  );
}

export async function getJob(handle: DbHandle, jobId: string): Promise<Job | null> {
  const rows = await handle.raw<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [jobId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listJobs(handle: DbHandle, runId: string): Promise<Job[]> {
  const rows = await handle.raw<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId],
  );
  return rows.map(toJob);
}
