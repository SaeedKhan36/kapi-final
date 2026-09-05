import { Hono } from "hono";
import type { DbHandle } from "@kapi/db";
import { JobTokenError, verifyJobToken, type JobTokenClaims } from "@kapi/identity";
import {
  AgentCancelRequestSchema, AgentCompleteRequestSchema, AgentEventsRequestSchema,
  AgentSpawnRequestSchema, agentId, isJobTerminal, normaliseVerdict,
  type AgentChild, type AgentInboxMessage, type EventKind,
  type SpawnedAgent, type SpawnRefusal,
} from "@kapi/protocol";
import {
  appendEvent, cancelSubtree, claim, complete, enqueue, fail, getJob, heartbeat,
  markRunning, toJob, JOB_COLUMNS, type JobRow,
} from "@kapi/queue";
import type { Store } from "./store.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import type { EventHub } from "./events.ts";
import { createModelProxy } from "./model-proxy.ts";

type Env = { Variables: { claims: JobTokenClaims } };

/**
 * The surface a VM talks to.
 *
 * Separate from `/api/*` because it authenticates differently: a job token, not
 * a user session. It is mounted without CORS - a browser has no business here.
 */
export function createAgentApi(deps: {
  handle: DbHandle;
  store: Store;
  hub: EventHub;
}) {
  const { handle, store, hub } = deps;
  const app = new Hono<Env>();

  app.use("/agent/*", async (c, next) => {
    try {
      c.set("claims", verifyJobToken(c.req.header("authorization")));
    } catch (err) {
      const message = err instanceof JobTokenError ? err.message : "unauthorized";
      return c.json({ error: message }, 401);
    }
    return next();
  });

  // A signed token identifies the VM that was originally assigned the job; it
  // is not itself proof that VM still owns the lease. Reapers deliberately
  // hand jobs to replacement VMs while the old token may remain unexpired.
  // Only claim and heartbeat have useful semantics without an active lease.
  app.use("/agent/*", async (c, next) => {
    if (c.req.path === "/agent/claim" || c.req.path === "/agent/heartbeat") {
      return next();
    }
    const { jobId, runId, vmId } = c.get("claims");
    const job = await getJob(handle, jobId);
    const active = job && job.runId === runId && job.vmId === vmId &&
      (job.status === "claimed" || job.status === "running");
    if (!active) {
      return c.json({ error: "job lease is no longer active" }, 409);
    }
    return next();
  });

  // Model calls, checkpoints and git credentials. Mounted after the token
  // middleware above, so these inherit the same authentication.
  app.route("/", createModelProxy({ handle }));

  /** Pushes anything just written straight to watching browsers. */
  const flush = async (runId: string, afterSeq: number) => {
    for (const e of await store.listEvents(runId, afterSeq)) hub.publish(e);
  };

  // Run status, and the captain's closing turn, live in one module shared with
  // the reaper's hook - a run must end the same way whether its captain
  // reported the result itself or lost its lease and was dead-lettered.
  const runs = createRunLifecycle({ handle, store });

  /**
   * Claim the job this token was minted for.
   *
   * Targeted rather than open-ended: the plane provisions a VM per job, so the
   * VM is told which job to take. It still goes through the same lease that a
   * pooled worker would, which is what keeps heartbeats and the reaper honest.
   */
  app.post("/agent/claim", async (c) => {
    const { jobId, runId, vmId } = c.get("claims");
    const before = (await store.getRun(runId))?.eventSeq ?? 0;

    const job = await claim(handle, { vmId, jobId, runId });
    if (!job) {
      // Already claimed, cancelled, or gated. Not an error - the agent should
      // shut down quietly rather than retry into a hot loop.
      const current = await getJob(handle, jobId);
      return c.json({ job: null, reason: current ? `job is ${current.status}` : "job not found" });
    }

    await handle.raw(
      `INSERT INTO agents (job_id, run_id, role, status, vm_id, last_heartbeat)
       VALUES ($1, $2, $3, 'claimed', $4, now())
       ON CONFLICT (job_id) DO UPDATE
         SET status = 'claimed', vm_id = EXCLUDED.vm_id,
             last_heartbeat = now(), stopped_at = NULL`,
      [job.id, job.runId, job.role, vmId],
    );

    await flush(runId, before);
    return c.json({ job });
  });

  /** claimed -> running, once the agent is actually working. */
  app.post("/agent/start", async (c) => {
    const { jobId, runId, vmId } = c.get("claims");
    const before = (await store.getRun(runId))?.eventSeq ?? 0;
    const job = await markRunning(handle, jobId, vmId);
    if (job) {
      await handle.raw(`UPDATE agents SET status = 'running' WHERE job_id = $1`, [jobId]);
      // A run is running once any of its agents is. Guarded inside, so this
      // announces the transition once however many agents start after it.
      // `before` was captured above, so the single flush covers both events.
      await runs.startRun(runId, jobId);
      await flush(runId, before);
    }
    return c.json({ ok: job !== null });
  });

  /**
   * Extend the lease.
   *
   * `ok: false` is the signal an agent must obey: it lost the lease and has to
   * stop. Returned as data rather than an error status because a polling loop
   * swallows a failed request far too easily.
   */
  app.post("/agent/heartbeat", async (c) => {
    const { jobId, vmId } = c.get("claims");
    const ok = await heartbeat(handle, jobId, vmId);
    const job = await getJob(handle, jobId);
    return c.json({ ok, cancelled: job?.status === "cancelled" });
  });

  /**
   * Append a batch of events.
   *
   * `runId` and the `from` address come from the token, not the body: an agent
   * says what happened, never who it is.
   */
  app.post("/agent/events", async (c) => {
    const { jobId, runId } = c.get("claims");
    const parsed = AgentEventsRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid events", issues: parsed.error.issues }, 400);

    const before = (await store.getRun(runId))?.eventSeq ?? 0;
    let seq = before;
    await handle.transaction(async (tx) => {
      for (const e of parsed.data.events) {
        seq = await appendEvent(tx, {
          runId, jobId, kind: e.kind, from: agentId(jobId), to: e.to ?? null, payload: e.payload,
        });
      }
    });

    await flush(runId, before);
    return c.json({ seq });
  });

  /**
   * Messages addressed to this agent, after a cursor.
   *
   * The `captain` alias resolves here rather than at the sender: a worker
   * asking its captain a question should not have to know the captain's job id,
   * and a worker spawned directly by the plane has no parent to address at all.
   * Without this the message is written and never delivered, which looks
   * exactly like a captain choosing not to answer.
   */
  app.get("/agent/inbox", async (c) => {
    const { jobId, runId } = c.get("claims");
    const after = Number(c.req.query("after") ?? 0);
    const me = agentId(jobId);

    const self = await getJob(handle, jobId);
    const addresses = [me, "broadcast"];
    if (self && self.kind === "captain" && self.parentJobId === null) addresses.push("captain");

    const rows = await handle.raw<{
      seq: number; kind: string; from_agent: string; payload: Record<string, unknown>;
    }>(
      `SELECT seq, kind, from_agent, payload FROM events
       WHERE run_id = $1 AND kind IN ('agent.message', 'ci.completed') AND seq > $2
         AND to_agent = ANY($3::text[])
       ORDER BY seq ASC LIMIT 100`,
      [runId, Number.isFinite(after) ? after : 0, addresses],
    );

    // The kind travels with the message. A worker's question and a completed
    // CI check arrive through the same inbox and demand opposite responses -
    // one blocks an agent until answered, the other cannot be replied to at all.
    const messages: AgentInboxMessage[] = rows.map((r) => ({
      seq: Number(r.seq),
      from: r.from_agent,
      kind: r.kind as EventKind,
      content: String(r.payload?.content ??
        (r.kind === "ci.completed" ? "GitHub CI completed." : "")),
      payload: r.payload ?? {},
    }));
    return c.json({ messages, cursor: messages.at(-1)?.seq ?? after });
  });

  /* ----------------------------------------------------------------- */
  /* Spawning, and watching what was spawned                            */
  /* ----------------------------------------------------------------- */

  /** How deep this job sits under the run's root. The root itself is 0. */
  const depthOf = async (jobId: string): Promise<number> => {
    const rows = await handle.raw<{ depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_job_id, 0 AS depth FROM jobs WHERE id = $1
         UNION ALL
         SELECT j.id, j.parent_job_id, c.depth + 1
         FROM jobs j JOIN chain c ON j.id = c.parent_job_id
       )
       SELECT COALESCE(max(depth), 0) AS depth FROM chain`,
      [jobId],
    );
    return Number(rows[0]?.depth ?? 0);
  };

  /**
   * Create agents.
   *
   * `runId` and `parentJobId` are taken from the token, exactly as everywhere
   * else on this surface: an agent says what it wants spawned, never where.
   *
   * Budgets do not throw. A captain that asks for six agents and can have two
   * gets two, plus a note saying why the other four did not happen, and decides
   * for itself whether to wait, narrow the work, or drop it. Killing the run
   * instead would make the budget a cliff rather than a constraint, and the
   * whole architecture is built on the captain staying in the loop.
   *
   * The concurrent-VM cap is deliberately NOT applied here. That one is
   * enforced by the provisioner at VM-start time, so queued work waits for a
   * free slot rather than being refused - a captain should never be told "no"
   * for work it can legitimately queue.
   */
  app.post("/agent/spawn", async (c) => {
    const { jobId, runId } = c.get("claims");
    const parsed = AgentSpawnRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid spawn request", issues: parsed.error.issues }, 400);
    }

    const run = await store.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);

    // repoUrl/baseBranch are how a job finds the repo to clone, and a spawned
    // child sees nothing of the conversation that decided to create it - only
    // what lands in its own context. Without inheriting the parent's here,
    // every child a captain spawns starts with no repo to work in at all.
    const parentJob = await getJob(handle, jobId);
    const parentContext = (parentJob?.payload.context ?? {}) as {
      repoUrl?: string; baseBranch?: string;
    };
    const inheritedContext: Record<string, unknown> = {};
    if (parentContext.repoUrl) inheritedContext.repoUrl = parentContext.repoUrl;
    if (parentContext.baseBranch) inheritedContext.baseBranch = parentContext.baseBranch;

    const before = run.eventSeq;
    const depth = (await depthOf(jobId)) + 1;
    const budget = {
      totalSpawns: run.totalSpawns,
      maxTotalSpawns: run.maxTotalSpawns,
      depth,
      maxSpawnDepth: run.maxSpawnDepth,
    };

    const spawned: SpawnedAgent[] = [];
    const refused: SpawnRefusal[] = [];

    // Soft across processes, like the VM cap: two planes could each read the
    // same total and jointly overshoot. It is a spend guard, and overshooting
    // it costs money rather than correctness.
    let remaining = Math.max(0, run.maxTotalSpawns - run.totalSpawns);

    for (const want of parsed.data.agents) {
      if (depth > run.maxSpawnDepth) {
        refused.push({
          role: want.role, instruction: want.instruction,
          reason: `spawn depth ${depth} exceeds this run's limit of ${run.maxSpawnDepth}. ` +
                  `Do this work yourself rather than delegating it further.`,
        });
        continue;
      }
      if (remaining <= 0) {
        refused.push({
          role: want.role, instruction: want.instruction,
          reason: `the run's total spawn budget of ${run.maxTotalSpawns} is used up. ` +
                  `No more agents can be created; finish with what is already running.`,
        });
        continue;
      }

      const job = await enqueue(handle, {
        runId,
        parentJobId: jobId,
        kind: want.kind,
        role: want.role,
        instruction: want.instruction,
        acceptance: want.acceptance,
        touches: want.touches,
        dependsOn: want.dependsOn,
        priority: want.priority,
        maxAttempts: 3,
        secrets: want.secrets,
        // The spawner's own context wins on conflict - it is free to hand a
        // child a different repo on purpose, this just stops "nothing at all"
        // from being the default.
        context: { ...inheritedContext, ...want.context },
      });
      remaining--;

      await handle.transaction(async (tx) => {
        await appendEvent(tx, {
          runId, jobId: job.id, kind: "agent.spawned", from: agentId(jobId),
          payload: {
            childJobId: job.id, kind: job.kind, role: job.role,
            instruction: job.payload.instruction, touches: job.payload.touches,
          },
        });
      });

      spawned.push({
        jobId: job.id, kind: job.kind, role: job.role,
        instruction: job.payload.instruction,
      });
    }

    await flush(runId, before);
    return c.json({
      spawned, refused,
      budget: { ...budget, totalSpawns: budget.totalSpawns + spawned.length },
    });
  });

  /**
   * What this agent spawned, and how it is going.
   *
   * Direct children only. A captain that spawned a sub-captain delegated that
   * subtree along with it, and reporting grandchildren here would invite it to
   * manage work it handed away.
   */
  app.get("/agent/children", async (c) => {
    const { jobId } = c.get("claims");
    const rows = await handle.raw<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE parent_job_id = $1 ORDER BY created_at ASC`,
      [jobId],
    );

    const children: AgentChild[] = rows.map(toJob).map((job) => ({
      jobId: job.id,
      kind: job.kind,
      role: job.role,
      status: job.status,
      instruction: job.payload.instruction,
      attempts: job.attempts,
      ok: job.result?.ok ?? null,
      summary: job.result?.summary ?? null,
      branch: job.result?.branch ?? null,
      prUrl: job.result?.prUrl ?? null,
      review: job.result?.review ?? null,
      error: job.error,
    }));

    return c.json({
      children,
      pending: children.filter(
        (ch) => ch.status === "queued" || ch.status === "claimed" || ch.status === "running",
      ).length,
    });
  });

  /**
   * Abandon a child and everything it spawned.
   *
   * Scoped to the caller's own descendants: a compromised or confused agent
   * must not be able to cancel a sibling's work, or another run's.
   */
  app.post("/agent/cancel-child", async (c) => {
    const { jobId, runId } = c.get("claims");
    const parsed = AgentCancelRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const target = await getJob(handle, parsed.data.jobId);
    if (!target || target.runId !== runId) return c.json({ error: "no such job" }, 404);

    const owned = await handle.raw<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_job_id FROM jobs WHERE id = $1
         UNION ALL
         SELECT j.id, j.parent_job_id FROM jobs j JOIN chain c ON j.id = c.parent_job_id
       )
       SELECT id FROM chain WHERE parent_job_id = $2 OR id = $2`,
      [target.id, jobId],
    );
    if (owned.length === 0) {
      return c.json({ error: "that job is not one of yours to cancel" }, 403);
    }

    const before = (await store.getRun(runId))?.eventSeq ?? 0;
    const cancelled = await cancelSubtree(handle, target.id, parsed.data.reason);
    await flush(runId, before);
    return c.json({ cancelled: cancelled.map((j) => j.id) });
  });

  /**
   * Finish. A `result` succeeds the job; an `error` fails it and lets the queue
   * decide between a retry and the dead letter.
   */
  app.post("/agent/complete", async (c) => {
    const { jobId, runId, vmId } = c.get("claims");
    const parsed = AgentCompleteRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);

    const before = (await store.getRun(runId))?.eventSeq ?? 0;
    const result = parsed.data.result?.review
      ? { ...parsed.data.result, review: normaliseVerdict(parsed.data.result.review) }
      : parsed.data.result;
    const job = parsed.data.error
      ? await fail(handle, jobId, vmId, parsed.data.error)
      : await complete(
          handle, jobId, vmId,
          result ?? { ok: true, summary: "finished", filesChanged: [], commits: [] },
        );

    if (!job) return c.json({ ok: false, reason: "lease lost" }, 409);
    if (result?.review) {
      await handle.transaction(async (tx) => {
        await tx(
          `INSERT INTO artifacts (id, run_id, job_id, kind, body)
           VALUES ($1, $2, $3, 'review.verdict', $4)
           ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, created_at = now()`,
          [`review_${jobId}`, runId, jobId, JSON.stringify(result.review)],
        );
        await appendEvent(tx, {
          runId,
          jobId,
          kind: "review.verdict",
          from: agentId(jobId),
          to: "captain",
          payload: { ...result.review, reviewerJobId: jobId },
        });
      });
    }

    // Before the flush, so the run.status event this may append travels with
    // the job transition that caused it rather than a poll interval behind.
    if (job.parentJobId === null && isJobTerminal(job.status)) await runs.finishRun(job);

    await flush(runId, before);
    return c.json({ ok: true, status: job.status });
  });

  return app;
}
