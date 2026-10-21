import { z } from "zod";

/**
 * The agent's model call, proxied through the control plane.
 *
 * The reasoning loop and every tool run ON the VM - that is the architecture.
 * Only the raw model request crosses back, for two reasons that outweigh the
 * extra network hop:
 *
 *   1. A provider key never has to exist inside a VM running generated code.
 *   2. The run's token and request budget is enforced in ONE place. A captain
 *      may have twenty agents alive; twenty VMs each enforcing their own copy
 *      of the budget does not add up to a run budget.
 */

export const ModelToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** JSON Schema for the tool's input. */
  inputSchema: z.record(z.unknown()),
});
export type ModelTool = z.infer<typeof ModelToolSchema>;

/** A model message, in the AI SDK's shape, kept loose on the wire. */
export const ModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
});
export type WireMessage = z.infer<typeof ModelMessageSchema>;

export const ModelRequestSchema = z.object({
  tier: z.enum(["reasoning", "coding", "cheap"]).default("coding"),
  system: z.string().optional(),
  messages: z.array(ModelMessageSchema).min(1),
  tools: z.array(ModelToolSchema).default([]),
  toolChoice: z.enum(["auto", "none", "required"]).default("auto"),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(64_000).optional(),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

export const ModelToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;

export const ModelResponseSchema = z.object({
  text: z.string(),
  toolCalls: z.array(ModelToolCallSchema),
  finishReason: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }),
  provider: z.string(),
  modelId: z.string(),
  /** Set when the run's budget is spent. The agent must land, not retry. */
  budgetExhausted: z.boolean().default(false),
});
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export const WorkspaceSnapshotSchema = z.object({
  publication: z.enum(["local", "published"]).default("local"),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  bundle: z.string().optional(),
  stagedPatch: z.string(),
  workingPatch: z.string(),
  untracked: z.array(z.object({ path: z.string(), data: z.string(), executable: z.boolean() })),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** Loop state persisted to the plane so a requeued job resumes on a new VM. */
export const CheckpointSchema = z.object({
  workspace: WorkspaceSnapshotSchema.optional(),
  step: z.number().int().nonnegative(),
  messages: z.array(ModelMessageSchema),
  /** Compacted summary of steps whose full text has been dropped. */
  summary: z.string().default(""),
  branch: z.string().optional(),
  commits: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
