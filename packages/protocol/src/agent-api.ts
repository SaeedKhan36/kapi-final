import { z } from "zod";
import { EventKindSchema } from "./events.ts";
import { JobKindSchema, JobResultSchema, JobStatusSchema } from "./jobs.ts";
import { AgentRoleSchema } from "./ids.ts";

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

/* ------------------------------------------------------------------ */
/* Spawning, and watching what was spawned                             */
/* ------------------------------------------------------------------ */

/**
 * One agent a captain wants to exist.
 *
 * Note what is absent: no ordering, no stage, no dependency on a plan. A
 * captain spawns what it wants when it wants, having seen what came back from
 * the last batch. `dependsOn` is available for the rare genuine ordering
 * constraint, not as a way to smuggle a pipeline back in.
 */
export const SpawnRequestSchema = z.object({
  kind: JobKindSchema.default("build"),
  role: AgentRoleSchema.default("generalist"),
  instruction: z.string().min(1),
  /** How the spawner will know this is done. The worker is judged on these. */
  acceptance: z.array(z.string()).default([]),
  /**
   * Files this agent is expected to touch. Advisory, and the main tool a
   * captain has for keeping parallel workers off each other's files.
   */
  touches: z.array(z.string()).default([]),
  /** Job ids that must SUCCEED first. Usually empty. */
  dependsOn: z.array(z.string()).default([]),
  priority: z.number().int().default(0),
  context: z.record(z.unknown()).default({}),
});
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/** A batch, so a captain can fan out in a single turn rather than N turns. */
export const AgentSpawnRequestSchema = z.object({
  agents: z.array(SpawnRequestSchema).min(1).max(20),
});
export type AgentSpawnRequest = z.infer<typeof AgentSpawnRequestSchema>;

export const SpawnedAgentSchema = z.object({
  jobId: z.string(),
  kind: JobKindSchema,
  role: AgentRoleSchema,
  instruction: z.string(),
});
export type SpawnedAgent = z.infer<typeof SpawnedAgentSchema>;

/**
 * An agent that was asked for and not created.
 *
 * This is data, not an error. A budget being reached is something the captain
 * has to reason about - drop the work, wait for a child to finish, or narrow
 * the plan - and it cannot do any of that from a thrown exception.
 */
export const SpawnRefusalSchema = z.object({
  role: AgentRoleSchema,
  instruction: z.string(),
  reason: z.string(),
});
export type SpawnRefusal = z.infer<typeof SpawnRefusalSchema>;

export const AgentSpawnResponseSchema = z.object({
  spawned: z.array(SpawnedAgentSchema).default([]),
  refused: z.array(SpawnRefusalSchema).default([]),
  budget: z.object({
    totalSpawns: z.number().int(),
    maxTotalSpawns: z.number().int(),
    depth: z.number().int(),
    maxSpawnDepth: z.number().int(),
  }),
});
export type AgentSpawnResponse = z.infer<typeof AgentSpawnResponseSchema>;

/** The monitor half. Without it a captain is blind to what it spawned. */
export const AgentChildSchema = z.object({
  jobId: z.string(),
  kind: JobKindSchema,
  role: AgentRoleSchema,
  status: JobStatusSchema,
  instruction: z.string(),
  attempts: z.number().int(),
  ok: z.boolean().nullish(),
  summary: z.string().nullish(),
  branch: z.string().nullish(),
  prUrl: z.string().nullish(),
  error: z.string().nullish(),
});
export type AgentChild = z.infer<typeof AgentChildSchema>;

export const AgentChildrenResponseSchema = z.object({
  children: z.array(AgentChildSchema).default([]),
  /** True while any child is still queued, claimed or running. */
  pending: z.number().int(),
});
export type AgentChildrenResponse = z.infer<typeof AgentChildrenResponseSchema>;

export const AgentCancelRequestSchema = z.object({
  jobId: z.string(),
  reason: z.string().default("cancelled by the captain"),
});
export type AgentCancelRequest = z.infer<typeof AgentCancelRequestSchema>;

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
