import { z } from "zod";
import { AgentRoleSchema, type AgentRole } from "./ids.ts";

/**
 * What kind of agent a job runs.
 *
 * Deliberately NOT a workflow. Nothing in this package says a captain must
 * precede a build, or that a review must follow one - a captain decides that at
 * runtime, and may spawn any kind at any time, including another captain.
 */
export const JobKindSchema = z.enum(["captain", "build", "review"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];
export const isJobTerminal = (s: JobStatus): boolean => TERMINAL_JOB_STATUSES.includes(s);

/** A job holding a live lease. Only these can heartbeat or be reaped. */
export const LEASED_JOB_STATUSES: readonly JobStatus[] = ["claimed", "running"];
export const isJobLeased = (s: JobStatus): boolean => LEASED_JOB_STATUSES.includes(s);

/** Sizing hints for the VM a job runs on. Consumed in Phase 2; stored now. */
export const VmSpecSchema = z.object({
  image: z.string().optional(),
  cpus: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  idleTtlSeconds: z.number().int().positive().optional(),
});
export type VmSpec = z.infer<typeof VmSpecSchema>;

/** Everything the agent needs to do the work, and nothing about scheduling. */
export const JobPayloadSchema = z.object({
  instruction: z.string().min(1),
  acceptance: z.array(z.string()).default([]),
  /** Files the spawner expects to be touched. Advisory. */
  touches: z.array(z.string()).default([]),
  vmSpec: VmSpecSchema.optional(),
  /** Free-form context the spawner wants carried through, e.g. a PR number. */
  context: z.record(z.unknown()).default({}),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export const FileRefSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted", "read"]).default("modified"),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const JobResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  filesChanged: z.array(FileRefSchema).default([]),
  commits: z.array(z.string()).default([]),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

/** What a caller hands to `enqueue`. Scheduling fields the queue owns are absent. */
export const JobSpecSchema = z.object({
  runId: z.string(),
  /** The job that spawned this one. Null for a run's root captain. */
  parentJobId: z.string().nullish(),
  kind: JobKindSchema,
  role: AgentRoleSchema,
  instruction: z.string().min(1),
  acceptance: z.array(z.string()).default([]),
  touches: z.array(z.string()).default([]),
  /** Job ids that must SUCCEED before this becomes claimable. Optional. */
  dependsOn: z.array(z.string()).default([]),
  /** Higher runs first. Lets a captain jump a fix ahead of queued work. */
  priority: z.number().int().default(0),
  maxAttempts: z.number().int().positive().default(3),
  vmSpec: VmSpecSchema.optional(),
  context: z.record(z.unknown()).default({}),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

/** A job row as it exists in the queue. */
export type Job = {
  id: string;
  runId: string;
  parentJobId: string | null;
  kind: JobKind;
  role: AgentRole;
  status: JobStatus;
  payload: JobPayload;
  result: JobResult | null;
  vmId: string | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  maxAttempts: number;
  priority: number;
  dependsOn: string[];
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};
