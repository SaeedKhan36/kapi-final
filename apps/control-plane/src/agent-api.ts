import { Hono } from "hono";
import type { DbHandle } from "@kapi/db";
import { JobTokenError, verifyJobToken, type JobTokenClaims } from "@kapi/identity";
import {
  AgentCompleteRequestSchema, AgentEventsRequestSchema, agentId,
  type AgentInboxMessage,
} from "@kapi/protocol";
import { claim, complete, fail, getJob, heartbeat, markRunning } from "@kapi/queue";
import { appendEvent } from "@kapi/queue";
import type { Store } from "./store.ts";
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

  // Model calls, checkpoints and git credentials. Mounted after the token
  // middleware above, so these inherit the same authentication.
  app.route("/", createModelProxy({ handle }));

  /** Pushes anything just written straight to watching browsers. */
  const flush = async (runId: string, afterSeq: number) => {
    for (const e of await store.listEvents(runId, afterSeq)) hub.publish(e);
  };

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

  /** Messages addressed to this agent, after a cursor. */
  app.get("/agent/inbox", async (c) => {
    const { jobId, runId } = c.get("claims");
    const after = Number(c.req.query("after") ?? 0);
    const me = agentId(jobId);

    const rows = await handle.raw<{
      seq: number; from_agent: string; payload: Record<string, unknown>;
    }>(
      `SELECT seq, from_agent, payload FROM events
       WHERE run_id = $1 AND kind = 'agent.message' AND seq > $2
         AND (to_agent = $3 OR to_agent = 'broadcast')
       ORDER BY seq ASC LIMIT 100`,
      [runId, Number.isFinite(after) ? after : 0, me],
    );

    const messages: AgentInboxMessage[] = rows.map((r) => ({
      seq: Number(r.seq),
      from: r.from_agent,
      content: String(r.payload?.content ?? ""),
      payload: r.payload ?? {},
    }));
    return c.json({ messages, cursor: messages.at(-1)?.seq ?? after });
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
    const job = parsed.data.error
      ? await fail(handle, jobId, vmId, parsed.data.error)
      : await complete(
          handle, jobId, vmId,
          parsed.data.result ?? { ok: true, summary: "finished", filesChanged: [], commits: [] },
        );

    if (!job) return c.json({ ok: false, reason: "lease lost" }, 409);
    await flush(runId, before);
    return c.json({ ok: true, status: job.status });
  });

  return app;
}
