/**
 * The wire shapes, as the control plane serialises them.
 *
 * Declared rather than imported from `@kapi/protocol`: that package is Node-only
 * (zod schemas, `node:crypto` in `ids.ts`), and pulling it into the browser
 * bundle to get types that JSON has already flattened - `Date` arrives as a
 * string - would be paying a runtime cost for a compile-time answer.
 */

export type JobStatus =
  | "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export type JobKind = "captain" | "build" | "review";

export type Health = {
  ok: boolean;
  database: string;
  auth: string;
  vault: string;
  queueDepth: number;
  wsClients: number;
  vmProvider: string;
};

export type Principal = { userId: string; email?: string | null; name?: string | null };

export type Project = {
  id: string; ownerId: string; name: string; repoUrl: string;
  defaultBranch: string; budgets: Record<string, number>; createdAt: string;
};

export type Thread = { id: string; projectId: string; title: string | null; createdAt: string };

export type Message = {
  id: string; threadId: string; role: "user" | "captain" | "system" | string;
  content: string; runId: string | null; createdAt: string;
};

export type Run = {
  id: string; threadId: string; projectId: string; goal: string; status: string;
  maxConcurrentVms: number; maxTotalSpawns: number; maxSpawnDepth: number;
  maxTokens: number; maxUsdCents: number;
  llmRequests: number; llmTokens: number; usdCents: number;
  totalSpawns: number; vmSeconds: number; eventSeq: number;
  error: string | null; createdAt: string; finishedAt: string | null;
};

export type FileRef = { path: string; action: string };

export type ReviewFinding = {
  severity: "blocker" | "major" | "minor" | "nit";
  file?: string; issue: string; suggestion?: string;
};

export type ReviewVerdict = {
  decision: "approve" | "request_changes";
  summary: string;
  findings: ReviewFinding[];
  acceptanceMet: boolean[];
};

export type JobResult = {
  ok: boolean; summary: string; filesChanged: FileRef[]; commits: string[];
  branch?: string; prUrl?: string; review?: ReviewVerdict; error?: string;
};

export type Job = {
  id: string; runId: string; parentJobId: string | null;
  kind: JobKind; role: string; status: JobStatus;
  payload: { instruction: string; acceptance: string[]; touches: string[]; context: Record<string, unknown> };
  result: JobResult | null;
  vmId: string | null; attempts: number; maxAttempts: number; priority: number;
  dependsOn: string[]; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};

export type EventKind =
  | "run.status" | "job.status" | "agent.spawned" | "agent.message"
  | "tool.call" | "tool.result" | "log" | "ci.completed" | "review.verdict";

export type RunEvent = {
  id: string; runId: string; jobId: string | null; seq: number;
  kind: EventKind; from: string; to: string | null;
  payload: Record<string, unknown>; ts: string;
};

export type RunDetail = {
  run: Run; jobs: Job[];
  agents: Record<string, unknown>[];
  events: RunEvent[];
  artifacts: Record<string, unknown>[];
};

/** What `WS /ws?runId=&cursor=` sends. */
export type StreamFrame =
  | { kind: "event"; event: RunEvent }
  | { kind: "replayed"; runId: string; cursor: number; count: number }
  | { kind: "ready"; runId: string | null }
  | { kind: "error"; error: string };

/** `agent:<jobId>` -> `<jobId>`. Anything else addresses no single job. */
export const jobIdOf = (address: string | null | undefined): string | null =>
  address?.startsWith("agent:") ? address.slice("agent:".length) : null;
