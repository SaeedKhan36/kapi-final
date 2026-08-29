import { z } from "zod";
import { EventKindSchema } from "./events.ts";
import { JobResultSchema } from "./jobs.ts";

/**
 * The agent's side of the wire.
 *
 * Every call is OUTBOUND from the VM. Sandboxes are not addressable inbound -
 * they may sit behind NAT, be destroyed at any moment, or never have been
 * reachable in the first place - so the plane never pushes and the agent dials.
 *
 * Identity comes from the job token, never from the body. An agent chooses
 * what it says, not who it is: `runId`, `jobId` and the `from` address are all
 * taken from the verified token, so a compromised VM cannot write into another
 * run's stream or complete a job that is not its own.
 */

export const AgentClaimRequestSchema = z.object({
  /** Reported for diagnostics; the authoritative vmId is in the token. */
  hostname: z.string().optional(),
});
export type AgentClaimRequest = z.infer<typeof AgentClaimRequestSchema>;

export const AgentEventInputSchema = z.object({
  kind: EventKindSchema,
  to: z.string().nullish(),
  payload: z.record(z.unknown()).default({}),
});
export type AgentEventInput = z.infer<typeof AgentEventInputSchema>;

/**
 * Events are posted in batches. One request per log line would make a chatty
 * agent's network cost dominate its actual work.
 */
export const AgentEventsRequestSchema = z.object({
  events: z.array(AgentEventInputSchema).min(1).max(200),
});
export type AgentEventsRequest = z.infer<typeof AgentEventsRequestSchema>;

export const AgentCompleteRequestSchema = z.object({
  result: JobResultSchema.optional(),
  /** Set instead of `result` to fail the job; the queue decides retry vs dead-letter. */
  error: z.string().optional(),
});
export type AgentCompleteRequest = z.infer<typeof AgentCompleteRequestSchema>;

export const AgentHeartbeatResponseSchema = z.object({
  /**
   * False means the lease is gone - the reaper handed this job to someone else.
   * The agent must stop immediately, or two VMs end up doing the same work and
   * pushing the same branch.
   */
  ok: z.boolean(),
  cancelled: z.boolean().default(false),
});
export type AgentHeartbeatResponse = z.infer<typeof AgentHeartbeatResponseSchema>;

/** Messages addressed to this agent, for a captain steering a worker mid-flight. */
export const AgentInboxMessageSchema = z.object({
  seq: z.number().int(),
  from: z.string(),
  content: z.string(),
  payload: z.record(z.unknown()).default({}),
});
export type AgentInboxMessage = z.infer<typeof AgentInboxMessageSchema>;

/** Environment the bootstrap hands to the agent process. */
export const AGENT_ENV = {
  url: "KAPI_CONTROL_PLANE_URL",
  token: "KAPI_JOB_TOKEN",
  jobId: "KAPI_JOB_ID",
  runId: "KAPI_RUN_ID",
  vmId: "KAPI_VM_ID",
  role: "KAPI_AGENT_ROLE",
  workdir: "KAPI_WORKDIR",
} as const;
