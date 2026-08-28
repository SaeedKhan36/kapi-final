import type { Job, JobKind, JobPayload, JobResult, JobStatus, AgentRole } from "@kapi/protocol";

/** A `jobs` row exactly as Postgres returns it. */
export type JobRow = {
  id: string;
  run_id: string;
  parent_job_id: string | null;
  kind: string;
  role: string;
  status: string;
  payload: JobPayload;
  result: JobResult | null;
  vm_id: string | null;
  lease_expires_at: string | Date | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  depends_on: string[];
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
};

const date = (v: string | Date | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v);

/**
 * Row -> Job. Drivers disagree on types: postgres-js hands back Date and real
 * numbers, PGlite hands back strings for some columns. Normalising here keeps
 * that difference out of every caller.
 */
export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    runId: row.run_id,
    parentJobId: row.parent_job_id,
    kind: row.kind as JobKind,
    role: row.role as AgentRole,
    status: row.status as JobStatus,
    payload: row.payload,
    result: row.result,
    vmId: row.vm_id,
    leaseExpiresAt: date(row.lease_expires_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    dependsOn: row.depends_on ?? [],
    error: row.error,
    createdAt: date(row.created_at)!,
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
  };
}

/** Every column of `jobs`, for RETURNING clauses. */
export const JOB_COLUMNS =
  "id, run_id, parent_job_id, kind, role, status, payload, result, vm_id, " +
  "lease_expires_at, attempts, max_attempts, priority, depends_on, error, " +
  "created_at, started_at, finished_at";
