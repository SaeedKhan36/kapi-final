import type { SqlRunner } from "@kapi/db";
import { newId, type EventInput, type EventKind, type JobStatus } from "@kapi/protocol";

/**
 * Appends one event, allocating the run's next sequence number.
 *
 * The `UPDATE ... RETURNING` takes a row lock on the run, so concurrent
 * appends to the same run serialise here. That is deliberate: a gap-free,
 * strictly ordered cursor is what makes UI resume and state replay correct,
 * and per-run event volume is nowhere near enough for the lock to matter.
 *
 * Always called inside the SAME transaction as the state change it describes,
 * so the stream can never disagree with job state.
 */
export async function appendEvent(tx: SqlRunner, input: EventInput): Promise<number> {
  const bumped = await tx<{ event_seq: number }>(
    `UPDATE runs SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`,
    [input.runId],
  );
  const seq = Number(bumped[0]?.event_seq);
  if (!Number.isFinite(seq)) {
    throw new Error(`cannot append event: run "${input.runId}" does not exist`);
  }

  await tx(
    `INSERT INTO events (id, run_id, job_id, seq, kind, from_agent, to_agent, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId("ev"),
      input.runId,
      input.jobId ?? null,
      seq,
      input.kind,
      input.from,
      input.to ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return seq;
}

/** Convenience for the transition every queue mutation records. */
export function jobStatusEvent(args: {
  runId: string;
  jobId: string;
  from?: JobStatus;
  to: JobStatus;
  vmId?: string | null;
  attempts?: number;
  detail?: string;
  actor?: string;
}): EventInput {
  return {
    runId: args.runId,
    jobId: args.jobId,
    kind: "job.status" satisfies EventKind,
    from: args.actor ?? "orchestrator",
    payload: {
      status: args.to,
      ...(args.from ? { from: args.from } : {}),
      ...(args.vmId !== undefined ? { vmId: args.vmId } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.detail ? { detail: args.detail } : {}),
    },
  };
}
