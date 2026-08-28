import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Time-prefixed, URL-safe, lowercase id. Sortable by creation because the
 * leading component is base36 milliseconds, which makes an id list readable in
 * the order things happened without joining on a timestamp.
 */
export function newId(prefix?: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

/**
 * Agent addressing.
 *
 *   "orchestrator"    the control plane itself
 *   "captain"         alias for the run's ROOT captain, so an agent can address
 *                     it without knowing its job id
 *   "agent:<jobId>"   any agent, including sub-captains and the root captain
 *   "broadcast"       fan-out to every agent on the run
 *
 * The old scheme was "worker:<role-slug>", which is unusable here: it assumes
 * one agent per role, and this architecture exists so a captain can spawn six
 * backend agents at once. One job is one agent is one address.
 */
export const AgentIdSchema = z
  .string()
  .regex(
    /^(orchestrator|captain|broadcast|agent:[a-z0-9][a-z0-9_-]{0,63})$/,
    "must be orchestrator | captain | broadcast | agent:<jobId>",
  );
export type AgentId = z.infer<typeof AgentIdSchema>;

export const agentId = (jobId: string): AgentId => `agent:${jobId}`;
export const isAgent = (id: AgentId): boolean => id.startsWith("agent:");
export const jobIdOf = (id: AgentId): string | null =>
  id.startsWith("agent:") ? id.slice("agent:".length) : null;

/**
 * What an agent is specialised for. A label on a job now, NOT an address -
 * routing is by job id, so two agents may share a role without colliding.
 */
export const AgentRoleSchema = z.enum([
  "captain",
  "frontend",
  "backend",
  "database",
  "testing",
  "infra",
  "docs",
  "research",
  "review",
  "generalist",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
