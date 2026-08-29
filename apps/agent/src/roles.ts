import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, Job, JobResult } from "@kapi/protocol";
import {
  BUILD_SYSTEM, BUILD_TOOLS, buildBrief, changedFiles, commitsOnBranch,
  prepareRepo, runLoop, type GitCredentials, type ToolContext,
} from "@kapi/agent-core";
import type { PlaneClient } from "./client.ts";

export type RoleContext = {
  job: Job;
  client: PlaneClient;
  workdir: string;
  /** False once the lease is lost or the job is cancelled. Check it in any loop. */
  alive: () => boolean;
};

export type RoleHandler = (ctx: RoleContext) => Promise<JobResult>;

/** Credentials are fetched once, lazily, and only if a tool actually pushes. */
function credentialCache(client: PlaneClient) {
  let cached: Promise<GitCredentials> | null = null;
  return () => (cached ??= client.gitCredentials() as Promise<GitCredentials>);
}

/**
 * Bridges the loop's tools to the plane.
 *
 * `askCaptain` polls the inbox rather than blocking on a socket, because the
 * VM has no inbound connectivity - everything the agent learns, it learns by
 * dialing out and asking.
 */
function toolContext(
  rc: RoleContext, cwd: string, gitCredentials: () => Promise<GitCredentials>,
): ToolContext {
  return {
    cwd,
    jobId: rc.job.id,
    runId: rc.job.runId,
    log: (message, extra) => rc.client.log(message, extra),
    gitCredentials,
    askCaptain: async (question, timeoutMs = 120_000) => {
      const parent = rc.job.parentJobId ? `agent:${rc.job.parentJobId}` : "captain";
      rc.client.emit("agent.message", { content: question, question: true }, parent);
      await rc.client.flush();

      const started = Date.now();
      let cursor = 0;
      while (Date.now() - started < timeoutMs) {
        if (!rc.alive()) return null;
        await new Promise((r) => setTimeout(r, 5_000));
        const { messages, cursor: next } = await rc.client.inbox(cursor);
        cursor = next;
        const reply = messages.find((m) => m.from === parent || m.from === "captain");
        if (reply) return reply.content;
      }
      return null;
    },
  };
}

/**
 * The Build agent: read the repo, make the change, test it, commit, push.
 *
 * Everything here runs on the VM. Only the model call goes back to the plane.
 */
export const buildRole: RoleHandler = async (rc) => {
  const { job, client } = rc;
  const context = job.payload.context as {
    repoUrl?: string; baseBranch?: string; brief?: string;
  };

  // A dedicated checkout per job, so two agents on one VM cannot collide.
  const cwd = await mkdtemp(join(rc.workdir || tmpdir(), "repo-"));
  const gitCredentials = credentialCache(client);
  const ctx = toolContext(rc, cwd, gitCredentials);

  let creds: GitCredentials | null = null;
  try {
    creds = await gitCredentials();
  } catch {
    // Expected when no GitHub credential is configured. The run still works;
    // the branch simply never leaves the VM.
    client.log("no push credential available - work will stay local to this VM");
  }

  const prepared = await prepareRepo(ctx, creds, {
    repoUrl: context.repoUrl ?? creds?.repoUrl ?? null,
    baseBranch: context.baseBranch ?? creds?.baseBranch ?? "main",
  });
  if (!prepared.ok) {
    return {
      ok: false, summary: `could not prepare the repository: ${prepared.detail}`,
      filesChanged: [], commits: [],
    };
  }
  client.log(prepared.detail, { branch: prepared.branch });

  // A resumed job continues rather than redoing work the run already paid for.
  const resumeFrom = await client.loadCheckpoint().catch(() => null);

  const brief = context.brief ?? buildBrief({
    instruction: job.payload.instruction,
    acceptance: job.payload.acceptance,
    touches: job.payload.touches,
    repoUrl: context.repoUrl ?? creds?.repoUrl ?? null,
    branch: prepared.branch,
  });

  const outcome = await runLoop({
    system: BUILD_SYSTEM,
    brief,
    tools: BUILD_TOOLS,
    ctx,
    alive: rc.alive,
    resumeFrom,
    callModel: (req) => client.model({
      tier: req.tier ?? "coding",
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      toolChoice: "auto",
      maxOutputTokens: req.maxOutputTokens ?? 8192,
    }),
    onCheckpoint: async (checkpoint: Checkpoint) => {
      // Best effort. Losing a checkpoint costs a resumed job some repeated
      // work; failing the job over it would cost all of it.
      await client.saveCheckpoint({ ...checkpoint, branch: prepared.branch }).catch(() => {});
    },
  });

  const base = context.baseBranch ?? creds?.baseBranch ?? "main";
  const commits = await commitsOnBranch(cwd, base);
  const files = await changedFiles(cwd, base);

  return {
    ok: outcome.ok,
    summary: outcome.summary,
    filesChanged: files.map((path) => ({ path, action: "modified" as const })),
    commits: commits.length > 0 ? commits : outcome.commits,
    branch: prepared.branch,
    ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
  };
};

/**
 * Phase 2 placeholder, still used by roles without their own loop yet.
 * Exercises the bootstrap path without a model in the picture.
 */
export const echoRole: RoleHandler = async ({ job, client, workdir, alive }) => {
  client.log(`agent online for ${job.kind}/${job.role}`, { workdir });
  client.emit("tool.call", { tool: "echo", args: { instruction: job.payload.instruction } });
  await client.flush();

  const { messages } = await client.inbox(0);
  if (messages.length > 0) client.log(`inbox: ${messages.length} message(s) waiting`);

  if (!alive()) {
    return { ok: false, summary: "lease lost before finishing", filesChanged: [], commits: [] };
  }
  client.emit("tool.result", { tool: "echo", ok: true });
  return {
    ok: true,
    summary: `echoed: ${job.payload.instruction.slice(0, 160)}`,
    filesChanged: [], commits: [],
  };
};

export const ROLES: Record<string, RoleHandler> = {
  build: buildRole,
  // Captain and review get their own loops in the phases after this one.
  captain: echoRole,
  review: echoRole,
};

export const handlerFor = (kind: string): RoleHandler => ROLES[kind] ?? echoRole;
