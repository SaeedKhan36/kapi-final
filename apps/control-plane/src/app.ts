import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { DbHandle } from "@kapi/db";
import {
  Authenticator, WorkOSError, deleteSecret, listSecrets, putSecret,
  vaultConfigured, type Principal, type SecretScope,
} from "@kapi/identity";
import { appendEvent, cancelSubtree, enqueue, getJob, listJobs } from "@kapi/queue";
import type { Store } from "./store.ts";
import type { EventHub } from "./events.ts";
import { createAgentApi } from "./agent-api.ts";
import { createConnectionRoutes } from "./connections.ts";
import { createGithubWebhookRoutes } from "./github-webhook.ts";

type Env = { Variables: { principal: Principal } };

const CreateProject = z.object({
  name: z.string().min(1).max(120),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1).default("main"),
  budgets: z.record(z.number().int().positive()).optional(),
});

const CreateThread = z.object({ title: z.string().max(200).optional() });

const PostMessage = z.object({
  content: z.string().min(1).max(20_000),
  budgets: z.record(z.number().int().positive()).optional(),
});

const PutSecret = z.object({
  scope: z.enum(["user", "project", "task"]),
  scopeId: z.string().min(1),
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "must be an UPPER_SNAKE env var name"),
  value: z.string().min(1).max(8192),
});

export function createApp(deps: {
  handle: DbHandle;
  store: Store;
  hub: EventHub;
  auth: Authenticator;
  vmProvider?: string;
}) {
  const { handle, store, hub, auth } = deps;
  const app = new Hono<Env>();

  app.use("/api/*", cors());

  // GitHub authenticates this route with its webhook signature, not with a
  // browser session. It must be mounted before the /api WorkOS middleware.
  app.route("/", createGithubWebhookRoutes({ handle, store, hub }));

  // Mounted before the /api auth middleware and outside CORS: agents
  // authenticate with a job token, not a user session, and no browser calls it.
  app.route("/", createAgentApi({ handle, store, hub }));

  /* -------------------------------------------------------------- health */

  app.get("/api/health", async (c) => {
    const rows = await handle.raw<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE status = 'queued'`,
    );
    return c.json({
      ok: true,
      database: handle.target,
      // "dev" means every request is the same local user and nothing is
      // authenticated. Reported plainly so it cannot be mistaken for real auth.
      auth: auth.mode,
      vault: vaultConfigured() ? "configured" : "NOT configured (set KAPI_SECRET_KEY)",
      queueDepth: Number(rows[0]?.n ?? 0),
      wsClients: hub.clientCount,
      vmProvider: deps.vmProvider ?? "none",
    });
  });

  /* ---------------------------------------------------------------- auth */

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    try {
      c.set("principal", await auth.authenticate(c.req.header("authorization")));
    } catch (err) {
      const status = err instanceof WorkOSError ? err.status : 401;
      const message = err instanceof Error ? err.message : "unauthenticated";
      return c.json({ error: message }, status as 401);
    }
    return next();
  });

  app.get("/api/me", (c) => c.json(c.get("principal")));

  // Mounted after the auth middleware: connecting an account is a user action.
  app.route("/", createConnectionRoutes({ handle }));

  /* ------------------------------------------------------------ projects */

  app.get("/api/projects", async (c) =>
    c.json(await store.listProjects(c.get("principal").userId)));

  app.post("/api/projects", async (c) => {
    const parsed = CreateProject.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const project = await store.createProject({
      ownerId: c.get("principal").userId, ...parsed.data,
    });
    return c.json(project, 201);
  });

  app.get("/api/projects/:id", async (c) => {
    const project = await store.getProject(c.req.param("id"), c.get("principal").userId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const [threads, runs] = await Promise.all([
      store.listThreads(project.id), store.listRuns(project.id),
    ]);
    return c.json({ project, threads, runs });
  });

  /* ------------------------------------------------------------- threads */

  app.post("/api/projects/:id/threads", async (c) => {
    const project = await store.getProject(c.req.param("id"), c.get("principal").userId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const parsed = CreateThread.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    return c.json(await store.createThread(project.id, parsed.data.title), 201);
  });

  app.get("/api/threads/:id", async (c) => {
    const found = await store.getThreadForOwner(c.req.param("id"), c.get("principal").userId);
    if (!found) return c.json({ error: "thread not found" }, 404);
    const messages = await store.listMessages(found.thread.id);
    return c.json({ ...found, messages });
  });

  /**
   * A message is how work starts. It records the turn, opens a run, and queues
   * the run's root captain job.
   *
   * Nothing is planned here and no pipeline is laid out - the captain decides
   * what to spawn once it is running. The control plane's whole responsibility
   * is to make one job exist and let a VM come and get it.
   */
  app.post("/api/threads/:id/messages", async (c) => {
    const principal = c.get("principal");
    const found = await store.getThreadForOwner(c.req.param("id"), principal.userId);
    if (!found) return c.json({ error: "thread not found" }, 404);

    const parsed = PostMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);

    const { thread, project } = found;
    const goal = parsed.data.content;

    const run = await store.createRun({
      threadId: thread.id,
      projectId: project.id,
      goal,
      budgets: { ...project.budgets, ...parsed.data.budgets },
    });

    const message = await store.createMessage({
      threadId: thread.id, role: "user", content: goal, runId: run.id,
    });

    const job = await enqueue(handle, {
      runId: run.id,
      parentJobId: null,
      kind: "captain",
      role: "captain",
      instruction: goal,
      acceptance: [],
      touches: [],
      dependsOn: [],
      priority: 10,
      maxAttempts: 3,
      context: {
        repoUrl: project.repoUrl,
        baseBranch: project.defaultBranch,
        threadId: thread.id,
        projectId: project.id,
      },
    });

    // The hub polls, but a caller that opened a socket first should see these
    // immediately rather than up to a poll interval later.
    for (const e of await store.listEvents(run.id, 0)) hub.publish(e);

    // Re-read: enqueue bumped the run's spawn and event counters, and returning
    // the pre-enqueue snapshot would show a run with one job and zero spawns.
    const fresh = (await store.getRun(run.id)) ?? run;
    return c.json({ message, run: fresh, job }, 202);
  });

  /* ---------------------------------------------------------------- runs */

  const ownsRun = async (c: { get: (k: "principal") => Principal }, runId: string) =>
    (await store.runOwner(runId)) === c.get("principal").userId;

  app.get("/api/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await ownsRun(c, id))) return c.json({ error: "run not found" }, 404);
    const detail = await store.getRunDetail(id);
    return detail ? c.json(detail) : c.json({ error: "run not found" }, 404);
  });

  app.get("/api/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!(await ownsRun(c, id))) return c.json({ error: "run not found" }, 404);
    const after = Number(c.req.query("after") ?? 0);
    return c.json(await store.listEvents(id, Number.isFinite(after) ? after : 0));
  });

  app.get("/api/runs/:id/jobs", async (c) => {
    const id = c.req.param("id");
    if (!(await ownsRun(c, id))) return c.json({ error: "run not found" }, 404);
    return c.json(await listJobs(handle, id));
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!(await ownsRun(c, id))) return c.json({ error: "run not found" }, 404);

    // Cancelling the root captain cascades through every agent it spawned.
    const jobs = await listJobs(handle, id);
    const roots = jobs.filter((j) => j.parentJobId === null);
    const cancelled = (await Promise.all(roots.map((r) => cancelSubtree(handle, r.id, "cancelled by user")))).flat();
    await store.setRunStatus(id, "cancelled");
    // One run-level event, so a watching browser does not have to infer the
    // run's fate from which of N job cancellations happened to be the root's.
    await handle.transaction(async (tx) => {
      await appendEvent(tx, {
        runId: id, kind: "run.status", from: "orchestrator",
        payload: { status: "cancelled", summary: "cancelled by user" },
      });
    });
    for (const e of await store.listEvents(id, 0)) hub.publish(e);
    return c.json({ cancelled: cancelled.length });
  });

  app.get("/api/jobs/:id", async (c) => {
    const job = await getJob(handle, c.req.param("id"));
    if (!job || !(await ownsRun(c, job.runId))) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  /* ------------------------------------------------------------- secrets */

  /**
   * Values go in and are never handed back. Every read path here returns names
   * and scopes only; the sole way plaintext leaves the vault is `resolve`,
   * which injects it into a VM.
   */
  const canUseScope = async (
    principal: Principal, scope: SecretScope, scopeId: string,
  ): Promise<boolean> => {
    if (scope === "user") return scopeId === principal.userId;
    if (scope === "project") return (await store.getProject(scopeId, principal.userId)) !== null;
    const job = await getJob(handle, scopeId);
    return job !== null && (await store.runOwner(job.runId)) === principal.userId;
  };

  app.get("/api/secrets", async (c) => {
    const principal = c.get("principal");
    const scope = (c.req.query("scope") ?? "user") as SecretScope;
    const scopeId = c.req.query("scopeId") ?? principal.userId;
    if (!(await canUseScope(principal, scope, scopeId))) {
      return c.json({ error: "scope not found" }, 404);
    }
    return c.json(await listSecrets(handle, scope, scopeId));
  });

  app.put("/api/secrets", async (c) => {
    const principal = c.get("principal");
    const parsed = PutSecret.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { scope, scopeId, name, value } = parsed.data;

    if (!(await canUseScope(principal, scope, scopeId))) {
      return c.json({ error: "scope not found" }, 404);
    }
    try {
      return c.json(await putSecret(handle, { scope, scopeId, name }, value), 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/secrets/:scope/:scopeId/:name", async (c) => {
    const principal = c.get("principal");
    const scope = c.req.param("scope") as SecretScope;
    const scopeId = c.req.param("scopeId");
    if (!(await canUseScope(principal, scope, scopeId))) {
      return c.json({ error: "scope not found" }, 404);
    }
    const removed = await deleteSecret(handle, scope, scopeId, c.req.param("name"));
    return removed ? c.json({ deleted: true }) : c.json({ error: "secret not found" }, 404);
  });

  return app;
}
