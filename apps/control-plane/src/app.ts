import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { DbHandle } from "@kapi/db";
import {
  Authenticator, GitHubApp, WorkOSError, deleteSecret, listSecrets, parseRepoUrl, putSecret,
  readAppConfig, vaultConfigured, type Principal, type SecretScope,
} from "@kapi/identity";
import { getJob, listJobs } from "@kapi/queue";
import type { Store } from "./store.ts";
import type { EventHub } from "./events.ts";
import { createAgentApi } from "./agent-api.ts";
import { createConnectionRoutes } from "./connections.ts";
import { createGithubWebhookRoutes } from "./github-webhook.ts";
import { RunService } from "./run-service.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { Scheduler } from "./scheduler.ts";
import { createWebAuthRoutes } from "./web-auth.ts";
import { allowedOrigins } from "./config.ts";
import { log } from "./log.ts";
import type { RequestTracker } from "./request-tracker.ts";

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

const ScheduleBody = z.object({
  name: z.string().min(1).max(120),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(100),
  goal: z.string().min(1).max(20_000),
  enabled: z.boolean().optional(),
});
const SchedulePatch = ScheduleBody.partial().refine((v) => Object.keys(v).length > 0);

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
  runService?: RunService;
  scheduler?: Scheduler;
  requests?: RequestTracker;
  githubApp?: GitHubApp | null;
}) {
  const { handle, store, hub, auth } = deps;
  const runService = deps.runService ?? new RunService(handle, store, hub);
  const scheduler = deps.scheduler ?? new Scheduler(handle, store, runService);
  const runLifecycle = createRunLifecycle({ handle, store });
  const app = new Hono<Env>();
  const origins = allowedOrigins();
  const githubConfig = readAppConfig();
  const githubApp = deps.githubApp === undefined
    ? (githubConfig ? new GitHubApp(githubConfig) : null)
    : deps.githubApp;
  const rate = new Map<string, { at: number; count: number }>();

  app.use("*", async (_c, next) => {
    const leave = deps.requests?.enter();
    try { await next(); } finally { leave?.(); }
  });
  app.use("*", secureHeaders());
  app.use("*", bodyLimit({ maxSize: Number(process.env.KAPI_MAX_BODY_BYTES ?? 2 * 1024 * 1024),
    onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const browserCors = cors({
    origin: (origin) => origins.includes(origin) ? origin : "",
    credentials: true,
  });
  app.use("/api/*", browserCors);
  app.use("/auth/*", browserCors);
  app.use("/api/*", async (c, next) => {
    const now = Date.now();
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const current = rate.get(key);
    const window = !current || now - current.at >= 60_000 ? { at: now, count: 0 } : current;
    window.count++; rate.set(key, window);
    if (window.count > Number(process.env.KAPI_RATE_LIMIT_PER_MINUTE ?? 300)) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    const started = Date.now();
    await next();
    const runId = c.req.path.match(/^\/api\/runs\/([^/]+)/)?.[1];
    const jobId = c.req.path.match(/^\/api\/jobs\/([^/]+)/)?.[1];
    log("info", "http.request", { requestId, method: c.req.method,
      path: c.req.path, status: c.res.status, durationMs: Date.now() - started,
      ...(runId ? { runId } : {}), ...(jobId ? { jobId } : {}) });
  });

  app.route("/", createWebAuthRoutes(auth));

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
  app.get("/live", (c) => c.json({ ok: true }));
  app.get("/ready", async (c) => {
    try {
      await handle.raw(`SELECT 1`);
      return c.json({ ok: true, database: true, auth: auth.mode, vault: vaultConfigured(),
        githubApp: Boolean(readAppConfig()),
        operations: process.env.KAPI_OPERATIONS === "off" ? "external-worker" : "in-process",
        vmProvider: deps.vmProvider ?? "none" });
    } catch (err) { return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503); }
  });

  app.get("/metrics", async (c) => {
    const required = process.env.KAPI_METRICS_TOKEN;
    if (required && c.req.header("authorization") !== `Bearer ${required}`) return c.text("unauthorized\n", 401);
    const rows = await handle.raw<{
      queued: number; leased: number; dead: number; active_vms: number; scheduler_lag: number;
      vm_seconds: number; budget_exhaustions: number;
    }>(`SELECT
      (SELECT count(*)::int FROM jobs WHERE status='queued') queued,
      (SELECT count(*)::int FROM jobs WHERE status IN ('claimed','running')) leased,
      (SELECT count(*)::int FROM jobs WHERE status='failed') dead,
      (SELECT count(*)::int FROM agents WHERE stopped_at IS NULL) active_vms,
      (SELECT COALESCE(sum(vm_seconds),0)::int FROM runs) vm_seconds,
      (SELECT count(*)::int FROM events WHERE kind='agent.message' AND payload->>'type'='budget.exhausted') budget_exhaustions,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(next_run_at)),0)::int FROM schedules
        WHERE enabled=true AND deleted_at IS NULL AND next_run_at < now()) scheduler_lag`);
    const m = rows[0] ?? { queued: 0, leased: 0, dead: 0, active_vms: 0, scheduler_lag: 0,
      vm_seconds: 0, budget_exhaustions: 0 };
    return c.text([
      `kapi_queue_queued ${m.queued}`, `kapi_queue_leased ${m.leased}`,
      `kapi_jobs_failed_total ${m.dead}`, `kapi_vms_active ${m.active_vms}`,
      `kapi_scheduler_lag_seconds ${m.scheduler_lag}`, "",
      `kapi_vm_seconds_total ${m.vm_seconds}`,
      `kapi_budget_exhaustions_total ${m.budget_exhaustions}`, "",
    ].join("\n"), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  /* ---------------------------------------------------------------- auth */

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    try {
      c.set("principal", await auth.authenticate(
        c.req.header("authorization"), c.req.header("cookie"),
      ));
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

  app.get("/api/setup", async (c) => {
    const principal = c.get("principal");
    const rows = await handle.raw<{
      provider: string; status: string; external_id: string | null; updated_at: string;
    }>(
      `SELECT provider,status,external_id,updated_at FROM connections WHERE user_id=$1`,
      [principal.userId],
    );
    const codex = rows.find((row) => row.provider === "codex");
    return c.json({
      auth: { mode: auth.mode, authenticated: principal.via === "workos" },
      vault: { configured: vaultConfigured() },
      vm: { provider: deps.vmProvider ?? "none" },
      github: { configured: githubApp !== null },
      codex: codex
        ? { connected: codex.status === "active", status: codex.status,
            accountId: codex.external_id, updatedAt: codex.updated_at }
        : { connected: false, status: "missing", accountId: null, updatedAt: null },
    });
  });

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

  app.get("/api/projects/:id/integrations", async (c) => {
    const project = await store.getProject(c.req.param("id"), c.get("principal").userId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!githubApp) {
      return c.json({ github: {
        configured: false, installed: false, action: "configure",
        reason: "Configure the Kapi GitHub App to push branches and open pull requests.",
      } });
    }
    const ref = parseRepoUrl(project.repoUrl);
    if (!ref) {
      return c.json({ github: {
        configured: true, installed: false, action: "configure",
        reason: "This project repository is not a supported GitHub HTTPS URL.",
      } });
    }
    try {
      const status = await githubApp.installationStatus(ref);
      return c.json({ github: { configured: true, ...status } });
    } catch (err) {
      return c.json({ github: {
        configured: true, installed: false, action: "retry",
        reason: err instanceof Error ? err.message : String(err),
      } });
    }
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

    const started = await runService.start({
      thread, project, goal, budgets: parsed.data.budgets, messageRole: "user",
    });
    return c.json(started, 202);
  });

  /* ----------------------------------------------------------- schedules */

  app.get("/api/projects/:id/schedules", async (c) => {
    const project = await store.getProject(c.req.param("id"), c.get("principal").userId);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(await scheduler.list(project.id));
  });

  app.post("/api/projects/:id/schedules", async (c) => {
    const project = await store.getProject(c.req.param("id"), c.get("principal").userId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const parsed = ScheduleBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    try { return c.json(await scheduler.create(project, parsed.data), 201); }
    catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 400); }
  });

  app.patch("/api/schedules/:id", async (c) => {
    const parsed = SchedulePatch.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    try {
      const schedule = await scheduler.update(c.req.param("id"), c.get("principal").userId, parsed.data);
      return schedule ? c.json(schedule) : c.json({ error: "schedule not found" }, 404);
    } catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 400); }
  });

  app.delete("/api/schedules/:id", async (c) =>
    (await scheduler.remove(c.req.param("id"), c.get("principal").userId))
      ? c.body(null, 204) : c.json({ error: "schedule not found" }, 404));

  app.post("/api/schedules/:id/run", async (c) => {
    const result = await scheduler.runNow(c.req.param("id"), c.get("principal").userId);
    if (!result) return c.json({ error: "schedule not found" }, 404);
    if (result.skipped) return c.json({ error: "schedule already has an active run", skipped: true }, 409);
    return c.json(result.run, 202);
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

    const cancelled = await runLifecycle.cancelRun(id);
    for (const e of await store.listEvents(id, 0)) hub.publish(e);
    return c.json({ cancelled });
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
