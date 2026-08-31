import type { AgentChild, AgentInboxMessage, SpawnRequest } from "@kapi/protocol";
import type { AgentTool, FleetOps, ToolContext } from "../types.ts";

/**
 * The captain's hands.
 *
 * These are the only tools that make one agent able to command another, and
 * they are deliberately the whole of it: spawn, look, wait, answer, cancel.
 * There is no "plan" tool and no way to declare a pipeline, because the moment
 * a captain can emit a fixed sequence it stops being an agent and becomes the
 * one-shot planner this architecture was rebuilt to get rid of.
 */

const fleetOf = (ctx: ToolContext): FleetOps | null => ctx.fleet ?? null;

const NO_FLEET =
  "ERROR: this agent cannot command other agents. Do the work yourself.";

/** A stable one-line rendering of a child, so a captain can diff turn to turn. */
function line(child: AgentChild): string {
  const head = `${child.jobId}  ${child.role}/${child.kind}  ${child.status}`;
  if (child.status === "succeeded" || child.status === "failed") {
    const verdict = child.ok === false ? "did not succeed" : "ok";
    const detail = child.summary ?? child.error ?? "(no summary)";
    const pr = child.prUrl ? `\n      pr: ${child.prUrl}` : "";
    const branch = child.branch ? `\n      branch: ${child.branch}` : "";
    const review = child.review
      ? `\n      review: ${child.review.decision}\n` +
        `      ${child.review.summary.replace(/\s+/g, " ")}\n` +
        (child.review.findings.length
          ? child.review.findings.map((finding, index) => {
              const file = finding.file ? ` ${finding.file}:` : "";
              const fix = finding.suggestion ? ` Fix: ${finding.suggestion}` : "";
              return `      ${index + 1}. [${finding.severity}]${file} ${finding.issue}${fix}`;
            }).join("\n")
          : "      no findings")
      : "";
    return `${head}  (${verdict})\n      ${detail.replace(/\s+/g, " ").slice(0, 400)}` +
      `${review}${branch}${pr}`;
  }
  return `${head}  — ${child.instruction.replace(/\s+/g, " ").slice(0, 120)}`;
}

function render(children: AgentChild[]): string {
  if (children.length === 0) return "You have not spawned any agents yet.";
  return children.map(line).join("\n");
}

/**
 * Spawn agents.
 *
 * Batched on purpose: a captain that has decided on six pieces of work should
 * start all six in one turn rather than paying six model calls to do it.
 */
export const spawnAgentsTool: AgentTool = {
  name: "spawn_agents",
  description:
    "Start one or more agents, each on its own VM and its own branch, working in parallel. " +
    "Give each one a self-contained task: it cannot see this conversation, only what you " +
    "write here. Use the touches field to keep two agents off the same files.",
  inputSchema: {
    type: "object",
    properties: {
      agents: {
        type: "array",
        description: "The agents to start. Prefer one batch over several turns.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["build", "review", "captain"],
              description:
                "build makes the change. review inspects a pull request. captain " +
                "delegates a whole sub-area and is worth it only for genuinely large work.",
            },
            role: {
              type: "string",
              enum: [
                "frontend", "backend", "database", "testing", "infra", "docs",
                "research", "review", "captain", "generalist",
              ],
              description: "A label for the event stream. It does not change the agent's tools.",
            },
            instruction: {
              type: "string",
              description:
                "The complete task, written for someone who has not seen this thread: what " +
                "to change, where, and why. This is all the agent gets.",
            },
            acceptance: {
              type: "array",
              items: { type: "string" },
              description: "How the agent will know it is done. It is judged on these.",
            },
            touches: {
              type: "array",
              items: { type: "string" },
              description:
                "Files or directories this agent should stay within. Overlapping two agents " +
                "here is how you get merge conflicts and lost work.",
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description:
                "Job ids that must SUCCEED before this one starts. Usually empty — parallel " +
                "is the point. Use it only for a real ordering constraint.",
            },
            base_branch: {
              type: "string",
              description:
                "Optional branch this work starts from. For a fixer, this may be the branch " +
                "whose review requested changes.",
            },
            branch: {
              type: "string",
              description:
                "For review agents, the candidate branch to inspect. When depends_on names " +
                "exactly one build job, its deterministic branch is inferred instead.",
            },
            pr_url: {
              type: "string",
              description: "Optional pull request URL supplied to a review agent.",
            },
            priority: {
              type: "number",
              description: "Higher priority runs sooner. Use this for a time-sensitive fixer.",
            },
            context: {
              type: "object",
              additionalProperties: true,
              description: "Additional role-specific context. Usually unnecessary.",
            },
          },
          required: ["instruction"],
        },
      },
    },
    required: ["agents"],
  },
  async run(input, ctx) {
    const fleet = fleetOf(ctx);
    if (!fleet) return { ok: false, output: NO_FLEET };

    const raw = Array.isArray(input.agents) ? input.agents : [];
    if (raw.length === 0) {
      return { ok: false, output: "No agents were described. Pass at least one." };
    }

    const agents: SpawnRequest[] = raw.map((a) => {
      const spec = (a ?? {}) as Record<string, unknown>;
      return {
        kind: (spec.kind as SpawnRequest["kind"]) ?? "build",
        role: (spec.role as SpawnRequest["role"]) ?? "generalist",
        instruction: String(spec.instruction ?? ""),
        acceptance: (spec.acceptance as string[] | undefined) ?? [],
        touches: (spec.touches as string[] | undefined) ?? [],
        // Accept both spellings: the schema the model sees uses snake_case,
        // and a model that has read the wire types may send either.
        dependsOn: (spec.depends_on as string[] | undefined)
          ?? (spec.dependsOn as string[] | undefined) ?? [],
        priority: Number(spec.priority ?? 0),
        context: {
          ...((spec.context as Record<string, unknown> | undefined) ?? {}),
          ...(spec.base_branch ? { baseBranch: String(spec.base_branch) } : {}),
          ...(spec.branch ? { branch: String(spec.branch) } : {}),
          ...(spec.pr_url ? { prUrl: String(spec.pr_url) } : {}),
        },
      };
    });

    const empty = agents.findIndex((a) => a.instruction.trim().length === 0);
    if (empty >= 0) {
      return { ok: false, output: `Agent ${empty + 1} has an empty instruction.` };
    }

    const res = await fleet.spawn(agents);

    const parts: string[] = [];
    if (res.spawned.length > 0) {
      parts.push(
        `Started ${res.spawned.length} agent(s):\n` +
        res.spawned.map((s) => `  ${s.jobId}  ${s.role}/${s.kind}`).join("\n"),
      );
    }
    // A refusal is information, not a failure. The captain decides what to do
    // about it, which is why this returns ok rather than marking the step bad.
    if (res.refused.length > 0) {
      parts.push(
        `Not started (${res.refused.length}):\n` +
        res.refused.map((r) => `  ${r.role}: ${r.reason}`).join("\n"),
      );
    }
    parts.push(
      `Spawn budget: ${res.budget.totalSpawns}/${res.budget.maxTotalSpawns} used, ` +
      `depth ${res.budget.depth}/${res.budget.maxSpawnDepth}.`,
    );
    if (res.spawned.length > 0) {
      parts.push("They are running now. Call wait_for_agents when you need their results.");
    }

    return {
      output: parts.join("\n\n"),
      meta: {
        spawned: res.spawned.map((s) => s.jobId),
        refused: res.refused.length,
      },
    };
  },
};

/**
 * The two kinds of thing that arrive in an agent's inbox, and what to do about
 * each.
 *
 * A worker's question blocks that worker until it is answered. A system notice
 * - a completed CI check - cannot be answered at all; the response is to spawn,
 * cancel, or ignore. Rendering both as "questions" produced a captain that
 * replied to `orchestrator`, an address nothing consumes, and burned a turn
 * doing it every time a check completed.
 */
type Inbox = { questions: AgentInboxMessage[]; notices: AgentInboxMessage[] };

/** GitHub conclusions that mean nobody is blocked. */
const CI_OK = new Set(["success", "neutral", "skipped"]);

const isCiFailure = (m: AgentInboxMessage): boolean =>
  m.kind === "ci.completed" && !CI_OK.has(String(m.payload?.conclusion ?? ""));

/**
 * Drains the inbox into its two buckets.
 *
 * `pollInbox` advances a cursor shared by every tool on this agent, so whoever
 * polls has CONSUMED these messages - a tool that drains without rendering
 * silently destroys a blocked worker's question. Every caller of this function
 * must render what it returns.
 */
async function drainInbox(fleet: FleetOps): Promise<Inbox> {
  const inbox: Inbox = { questions: [], notices: [] };
  for (const m of await fleet.pollInbox()) {
    // `agent.message` is the only kind an agent can author into another's
    // inbox - the plane stamps `from` from the job token - so everything else
    // came from the orchestrator and cannot be replied to.
    (m.kind === "agent.message" ? inbox.questions : inbox.notices).push(m);
  }
  return inbox;
}

const describeNotice = (m: AgentInboxMessage): string => {
  if (m.kind !== "ci.completed") return `${m.from}: ${m.content}`;
  const p = m.payload ?? {};
  const name = String(p.name ?? "GitHub check");
  const conclusion = String(p.conclusion ?? "completed");
  const branch = p.branch ? ` on ${String(p.branch)}` : "";
  const url = p.url ? ` ${String(p.url)}` : "";
  return `CI ${name}: ${conclusion}${branch}${url}`;
};

/** Renders both buckets, each saying what the captain can actually do about it. */
function renderInbox(inbox: Inbox): string[] {
  const parts: string[] = [];
  if (inbox.questions.length > 0) {
    parts.push(
      "Questions waiting for you - each of these workers is blocked until you " +
      "answer with reply_to_agent, using the job id shown:\n" +
      inbox.questions.map((m) => `  ${m.from}: ${m.content}`).join("\n"),
    );
  }
  if (inbox.notices.length > 0) {
    parts.push(
      "System notices - information only. You cannot reply to these; act on one " +
      "by spawning an agent, cancelling work it invalidates, or ignoring it:\n" +
      inbox.notices.map((m) => `  ${describeNotice(m)}`).join("\n"),
    );
  }
  return parts;
}

/** A snapshot, without waiting. Cheap enough to call between other work. */
export const checkAgentsTool: AgentTool = {
  name: "check_agents",
  description:
    "Show every agent you have started and its current state, without waiting. " +
    "Use this to decide whether to spawn more work while others are still running. " +
    "Also delivers anything waiting for you: questions from workers, and system " +
    "notices such as completed CI checks.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    const fleet = fleetOf(ctx);
    if (!fleet) return { ok: false, output: NO_FLEET };
    const { children, pending } = await fleet.children();
    // Drains the inbox too. Only wait_for_agents used to poll, so a CI result
    // that landed while the captain was spawning and checking stayed invisible
    // until the next wait - and was never seen at all by a captain that
    // finished without waiting again.
    const inbox = await drainInbox(fleet);
    const parts = [render(children), `${pending} still running.`, ...renderInbox(inbox)];
    return {
      output: parts.join("\n\n"),
      meta: {
        pending, total: children.length,
        questions: inbox.questions.length, notices: inbox.notices.length,
      },
    };
  },
};

/**
 * Wait for agents to finish.
 *
 * Bounded, and it returns what it has when the time is up rather than failing.
 * A captain blocked forever on a VM that died is a run nobody can rescue, and
 * the reaper will requeue genuinely lost work underneath this anyway.
 *
 * Questions from workers are surfaced here too. A worker that calls
 * `ask_captain` while its captain sits in a wait would otherwise time out
 * against a captain that was technically available the whole time.
 *
 * System notices - CI results - are surfaced separately, because they demand
 * the opposite response: nobody is blocked on them and they cannot be replied
 * to. Only a FAILING check ends the wait early.
 */
export const waitForAgentsTool: AgentTool = {
  name: "wait_for_agents",
  description:
    "Wait until the agents you started have finished, then return their results. " +
    "Returns early if they all finish, and returns what it has if the wait runs out. " +
    "Also returns early when a worker asks you a question or a CI check fails, " +
    "since both are worth acting on immediately.",
  inputSchema: {
    type: "object",
    properties: {
      job_ids: {
        type: "array",
        items: { type: "string" },
        description: "Which agents to wait for. Omit to wait for all of yours.",
      },
      timeout_seconds: {
        type: "number",
        description: "How long to wait. Default 600, maximum 1800.",
      },
    },
  },
  async run(input, ctx) {
    const fleet = fleetOf(ctx);
    if (!fleet) return { ok: false, output: NO_FLEET };

    const want = new Set(
      (Array.isArray(input.job_ids) ? input.job_ids : []).map(String).filter(Boolean),
    );
    const timeoutMs = Math.min(
      1_800_000,
      Math.max(0, Number(input.timeout_seconds ?? 600) * 1000),
    );
    const isDone = (ch: AgentChild) =>
      ch.status === "succeeded" || ch.status === "failed" || ch.status === "cancelled";

    const started = Date.now();
    const inbox: Inbox = { questions: [], notices: [] };
    let children: AgentChild[] = [];
    let stopped = "";

    // Poll rather than subscribe: the VM has no inbound connectivity, so
    // everything this agent learns, it learns by dialing out and asking.
    for (;;) {
      const snapshot = await fleet.children();
      children = want.size > 0
        ? snapshot.children.filter((ch) => want.has(ch.jobId))
        : snapshot.children;

      const drained = await drainInbox(fleet);
      inbox.questions.push(...drained.questions);
      inbox.notices.push(...drained.notices);

      const outstanding = children.filter((ch) => !isDone(ch));
      if (children.length > 0 && outstanding.length === 0) break;
      if (children.length === 0 && want.size === 0) {
        stopped = "You have not started any agents, so there was nothing to wait for.";
        break;
      }
      // A question answered late is a worker that already guessed. Hand it back
      // straight away so the captain can reply on its next turn.
      if (inbox.questions.length > 0) {
        stopped = "A worker is waiting on an answer from you.";
        break;
      }
      // A red check is actionable now - spawn a fixer naming it, or cancel what
      // depended on it - and making the captain sit out a ten-minute wait to
      // learn that is the same mistake at a different altitude. A green check
      // blocks nobody, so it rides along and is rendered when the wait ends for
      // some other reason.
      if (drained.notices.some(isCiFailure)) {
        stopped = "A CI check failed on one of your agents' branches.";
        break;
      }
      if (ctx.alive && !ctx.alive()) { stopped = "This job is no longer live; stopping."; break; }
      if (Date.now() - started >= timeoutMs) {
        stopped = `Still running after ${Math.round(timeoutMs / 1000)}s.`;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }

    const parts = [render(children), ...renderInbox(inbox)];
    if (stopped) parts.push(stopped);

    return {
      output: parts.join("\n\n"),
      meta: {
        waited: Math.round((Date.now() - started) / 1000),
        done: children.filter(isDone).length,
        total: children.length,
      },
    };
  },
};

export const replyToAgentTool: AgentTool = {
  name: "reply_to_agent",
  description:
    "Answer a worker that asked you a question. It is blocked waiting, so be brief and " +
    "decisive — tell it what to do, not what the options are.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "The agent that asked. Shown in the question." },
      answer: { type: "string" },
    },
    required: ["job_id", "answer"],
  },
  async run(input, ctx) {
    const fleet = fleetOf(ctx);
    if (!fleet) return { ok: false, output: NO_FLEET };

    const jobId = String(input.job_id ?? "").trim();
    const answer = String(input.answer ?? "").trim();
    if (!jobId || !answer) return { ok: false, output: "Both job_id and answer are required." };

    // A system notice has no author to answer. Prefixing one of these produces
    // `agent:orchestrator`, an address the protocol rejects and nothing
    // consumes - the reply vanishes and the captain believes it responded.
    if (["orchestrator", "captain", "broadcast"].includes(jobId)) {
      return {
        ok: false,
        output:
          `"${jobId}" is not a worker, so there is nobody to answer. System notices ` +
          `such as CI results cannot be replied to - act on one by spawning an agent, ` +
          `cancelling work it invalidates, or ignoring it.`,
      };
    }

    // Addresses are `agent:<jobId>`; accept either form, since a captain
    // reading the event stream sees the prefixed one.
    const address = jobId.startsWith("agent:") ? jobId : `agent:${jobId}`;
    await fleet.sendTo(address, answer);
    return { output: `Answered ${address}.` };
  },
};

/**
 * Abandon a line of work.
 *
 * Cancels the child's own descendants with it. A cancelled agent whose
 * grandchildren keep running is a run still burning VMs for a result nobody
 * will read.
 */
export const cancelAgentTool: AgentTool = {
  name: "cancel_agent",
  description:
    "Stop an agent you started, and everything it started. Use this when its work has " +
    "become unnecessary or it is clearly stuck — not merely because it is slow.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      reason: { type: "string", description: "Recorded in the run's event stream." },
    },
    required: ["job_id"],
  },
  async run(input, ctx) {
    const fleet = fleetOf(ctx);
    if (!fleet) return { ok: false, output: NO_FLEET };

    const jobId = String(input.job_id ?? "").replace(/^agent:/, "").trim();
    if (!jobId) return { ok: false, output: "job_id is required." };

    try {
      const cancelled = await fleet.cancelChild(jobId, String(input.reason ?? "") || undefined);
      if (cancelled.length === 0) {
        return { output: `${jobId} had already finished; nothing was cancelled.` };
      }
      return {
        output: `Cancelled ${cancelled.length} job(s): ${cancelled.join(", ")}.`,
        meta: { cancelled },
      };
    } catch (err) {
      return { ok: false, output: `Could not cancel ${jobId}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
