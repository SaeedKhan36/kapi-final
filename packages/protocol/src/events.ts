import { z } from "zod";
import { AgentIdSchema } from "./ids.ts";
import { JobStatusSchema } from "./jobs.ts";

/**
 * The append-only stream.
 *
 * One table is simultaneously the audit log, the UI feed, and the record of
 * what each agent did. kapi-old proved the consolidation works (it used
 * `agent_messages` this way); the difference here is that job state transitions
 * are events too, written in the SAME transaction as the state change. That is
 * what lets a replay of `events` reproduce every job's status - and what lets a
 * reconnecting UI resume from a cursor without missing anything.
 */
export const EventKindSchema = z.enum([
  "run.status",
  "job.status",
  "agent.spawned",
  "agent.message",
  "tool.call",
  "tool.result",
  "log",
  "ci.completed",
  "review.verdict",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const AgentEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** The job this event is about. Null for run-level events. */
  jobId: z.string().nullish(),
  /** Monotonic per run, assigned by the database. The UI's resume cursor. */
  seq: z.number().int().nonnegative(),
  kind: EventKindSchema,
  from: AgentIdSchema,
  to: AgentIdSchema.nullish(),
  payload: z.record(z.unknown()).default({}),
  ts: z.string().datetime(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** What a caller passes to `appendEvent`; id, seq and ts are assigned for it. */
export type EventInput = {
  runId: string;
  jobId?: string | null;
  kind: EventKind;
  from: string;
  to?: string | null;
  payload?: Record<string, unknown>;
};

/** Payload shape for `job.status`, the event a state replay depends on. */
export const JobStatusPayloadSchema = z.object({
  status: JobStatusSchema,
  from: JobStatusSchema.optional(),
  vmId: z.string().nullish(),
  attempts: z.number().int().optional(),
  detail: z.string().optional(),
});
export type JobStatusPayload = z.infer<typeof JobStatusPayloadSchema>;
