import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderChangeRequest,
  type AgentInboxMessage, type Checkpoint, type Job, type JobResult,
} from "@kapi/protocol";
import {
  BUILD_SYSTEM, BUILD_TOOLS, buildBrief, CAPTAIN_SYSTEM, CAPTAIN_TOOLS, captainBrief,
  REVIEW_SYSTEM, REVIEW_TOOLS, changedFiles, commitsOnBranch, prepareRepo,
  reviewBrief, runLoop, verdictFromOutcome,
  type FleetOps, type GitCredentials, type ToolContext,
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
  rc: RoleContext,
  cwd: string,
  gitCredentials: () => Promise<GitCredentials>,
  fleet?: FleetOps,
): ToolContext {
  return {
    cwd,
    jobId: rc.job.id,
    runId: rc.job.runId,
    log: (message, extra) => rc.client.log(message, extra),
    gitCredentials,
    fleet,
    // Long-running tools poll this. A tool that waits ten minutes on a job the
    // reaper already handed to another VM is working for a run that moved on.
    alive: rc.alive,
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
        // Only a real message answers a question. A worker's inbox cannot
        // receive a CI notice today, but the guard keeps that invariant here
        // rather than inferred from a routing rule two packages away.
        const reply = messages.find(
          (m) => m.kind === "agent.message" && (m.from === parent || m.from === "captain"),
        );
        if (reply) return reply.content;
      }
      return null;
    },
  };
}

/**
 * The captain's command channel.
 *
 * Every operation dials out - the VM has no inbound connectivity, so a captain
 * learns what its fleet is doing by asking, never by being told. The inbox
 * cursor lives in this closure so repeated polls do not re-read old messages.
 */
function fleetOps(client: PlaneClient): FleetOps {
  let inboxCursor = 0;
  return {
    spawn: (agents) => client.spawn(agents),
    children: () => client.children(),
    cancelChild: async (jobId, reason) => (await client.cancelChild(jobId, reason)).cancelled,
    sendTo: async (address, content) => {
      client.emit("agent.message", { content }, address);
      // Flushed immediately: a buffered reply is a worker still blocked.
      await client.flush();
    },
    pollInbox: async (): Promise<AgentInboxMessage[]> => {
      const { messages, cursor } = await client.inbox(inboxCursor);
      inboxCursor = cursor;
      return messages;
    },
  };
}

/**
 * The Captain: understand the goal, delegate it, watch what comes back, decide.
 *
 * It never writes code. Its checkout is read-only and its tool list has no
 * editor in it - a captain that can edit stops delegating, and then the fleet
 * is one agent again, which is the failure this architecture exists to avoid.
 *
 * There is no pipeline here. What it spawns, when, and how many times is the
 * model's decision from what its agents actually reported.
 */
export const captainRole: RoleHandler = async (rc) => {
  const { job, client } = rc;
  const context = job.payload.context as {
    repoUrl?: string; baseBranch?: string; brief?: string;
    threadHistory?: Array<{ role: string; content: string }>;
  };

  const cwd = await mkdtemp(join(rc.workdir || tmpdir(), "explore-"));
  const gitCredentials = credentialCache(client);
  const fleet = fleetOps(client);
  const ctx = toolContext(rc, cwd, gitCredentials, fleet);

  let creds: GitCredentials | null = null;
  try {
    creds = await gitCredentials();
  } catch {
    client.log("no git credential - exploring whatever the VM can reach");
  }

  const repoUrl = context.repoUrl ?? creds?.repoUrl ?? null;
  const baseBranch = context.baseBranch ?? creds?.baseBranch ?? "main";

  // Failing to clone is not fatal for a captain. It can still delegate from the
  // goal alone; its instructions are just less specific for it.
  const prepared = await prepareRepo(ctx, creds, { repoUrl, baseBranch, readOnly: true });
  client.log(prepared.ok ? prepared.detail : `could not clone: ${prepared.detail}`);

  const resumeFrom = await client.loadCheckpoint().catch(() => null);

  const brief = context.brief ?? captainBrief({
    goal: job.payload.instruction,
    acceptance: job.payload.acceptance,
    repoUrl,
    baseBranch,
    threadHistory: context.threadHistory,
  });

  const outcome = await runLoop({
    system: CAPTAIN_SYSTEM,
    brief,
    tools: CAPTAIN_TOOLS,
    ctx,
    alive: rc.alive,
    resumeFrom,
    tier: "reasoning",
    // A captain spends steps waiting and re-planning rather than editing, so
    // the build agent's cap is the wrong shape for it.
    maxSteps: Number(process.env.KAPI_CAPTAIN_MAX_STEPS ?? 60),
    // Far wider than a build agent's window. A captain's whole job is to hold
    // what it learned while exploring long enough to write good instructions
    // from it, and its transcript is cheap - it never writes a file into one.
    keepFullSteps: Number(process.env.KAPI_CAPTAIN_KEEP_FULL_STEPS ?? 16),
    callModel: (req) => client.model({
      tier: req.tier ?? "reasoning",
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      toolChoice: "auto",
      maxOutputTokens: req.maxOutputTokens ?? 8192,
    }),
    onCheckpoint: async (checkpoint: Checkpoint) => {
      await client.saveCheckpoint(checkpoint).catch(() => {});
    },
  });

  // What the fleet actually produced. This is what a user reads in the thread
  // and what the review loop will pick up, so it reports the children's work
  // rather than only the captain's own account of it.
  const { children } = await client.children().catch(() => ({ children: [] }));
  const succeeded = children.filter((ch) => ch.status === "succeeded");
  const failed = children.filter((ch) => ch.status === "failed");
  const branches = succeeded.map((ch) => ch.branch).filter((b): b is string => Boolean(b));

  const fleetLine = children.length
    ? `Fleet: ${succeeded.length}/${children.length} agent(s) succeeded` +
      (failed.length ? `, ${failed.length} failed` : "") +
      (branches.length ? `. Branches: ${branches.join(", ")}` : "")
    : "Fleet: no agents were started.";

  return {
    ok: outcome.ok && failed.length === 0,
    summary: `${outcome.summary}

${fleetLine}`,
    filesChanged: [],
    commits: [],
    ...(branches.length === 1 ? { branch: branches[0] } : {}),
  };
};

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
 * The Review agent: clone the candidate branch, inspect it without write
 * tools, and return a normalized structured verdict to its captain.
 */
export const reviewRole: RoleHandler = async (rc) => {
  const { job, client } = rc;
  const context = job.payload.context as {
    repoUrl?: string; baseBranch?: string; branch?: string;
    prUrl?: string; brief?: string;
  };

  // Depending on one build job is the natural review handoff. Its branch name
  // is deterministic, so a captain need not copy it through free-form context.
  const targetBranch = context.branch ??
    (job.dependsOn.length === 1 ? `kapi/${job.dependsOn[0]}` : null);
  if (!targetBranch) {
    return {
      ok: false,
      summary:
        "review target missing: pass context.branch or depend on exactly one build job",
      filesChanged: [], commits: [],
    };
  }

  const cwd = await mkdtemp(join(rc.workdir || tmpdir(), "review-"));
  const gitCredentials = credentialCache(client);
  const ctx = toolContext(rc, cwd, gitCredentials);

  let creds: GitCredentials | null = null;
  try {
    creds = await gitCredentials();
  } catch {
    client.log("no git credential available - review can only use a public repository");
  }

  const repoUrl = context.repoUrl ?? creds?.repoUrl ?? null;
  const baseBranch = context.baseBranch ?? creds?.baseBranch ?? "main";
  const prepared = await prepareRepo(ctx, creds, {
    repoUrl,
    baseBranch: targetBranch,
    readOnly: true,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      summary: `could not prepare review branch ${targetBranch}: ${prepared.detail}`,
      filesChanged: [], commits: [],
    };
  }
  client.log(`reviewing ${targetBranch} against ${baseBranch}`);

  const resumeFrom = await client.loadCheckpoint().catch(() => null);
  const brief = context.brief ?? reviewBrief({
    instruction: job.payload.instruction,
    acceptance: job.payload.acceptance,
    repoUrl,
    baseBranch,
    branch: targetBranch,
    prUrl: context.prUrl,
  });

  const outcome = await runLoop({
    system: REVIEW_SYSTEM,
    brief,
    tools: REVIEW_TOOLS,
    ctx,
    alive: rc.alive,
    resumeFrom,
    tier: "reasoning",
    maxSteps: Number(process.env.KAPI_REVIEW_MAX_STEPS ?? 30),
    keepFullSteps: Number(process.env.KAPI_REVIEW_KEEP_FULL_STEPS ?? 10),
    callModel: (req) => client.model({
      tier: req.tier ?? "reasoning",
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      toolChoice: "auto",
      maxOutputTokens: req.maxOutputTokens ?? 8192,
    }),
    onCheckpoint: async (checkpoint: Checkpoint) => {
      await client.saveCheckpoint({ ...checkpoint, branch: targetBranch }).catch(() => {});
    },
  });

  const verdict = verdictFromOutcome(outcome.terminalMeta);
  if (!outcome.ok || !verdict) {
    return {
      ok: false,
      summary: verdict ? outcome.summary : `${outcome.summary} No valid review verdict was submitted.`,
      filesChanged: [], commits: [], branch: targetBranch,
    };
  }

  const summary = verdict.decision === "request_changes"
    ? renderChangeRequest(verdict)
    : `Review approved: ${verdict.summary}`;
  return {
    // request_changes is a completed review, not an infrastructure failure.
    // The captain receives the decision and chooses whether to spawn a fixer.
    ok: true,
    summary,
    review: verdict,
    filesChanged: [],
    commits: [],
    branch: targetBranch,
    ...(context.prUrl ? { prUrl: context.prUrl } : {}),
  };
};

/** Deterministic test-only role that exercises bootstrap without a model. */
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
  captain: captainRole,
  review: reviewRole,
};

export const handlerFor = (kind: string): RoleHandler => {
  if (process.env.KAPI_TEST_ECHO_ROLE === "true") return echoRole;
  const handler = ROLES[kind];
  if (!handler) throw new Error(`unsupported agent role kind: ${kind}`);
  return handler;
};
