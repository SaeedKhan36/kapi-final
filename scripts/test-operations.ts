import { createDb, truncateAll, type DbHandle } from "@kapi/db";
import { newId } from "@kapi/protocol";
import { claim, complete, enqueue, listJobs, markRunning } from "@kapi/queue";
import type { ManagedVm, Vm, VmProvider, VmSpec } from "@kapi/vm";
import { Store } from "../apps/control-plane/src/store.ts";
import { RunService } from "../apps/control-plane/src/run-service.ts";
import { Scheduler, nextOccurrence } from "../apps/control-plane/src/scheduler.ts";
import { UsageAccounting } from "../apps/control-plane/src/accounting.ts";
import { VmReconciler } from "../apps/control-plane/src/reconciler.ts";
import { createRunLifecycle } from "../apps/control-plane/src/run-lifecycle.ts";
import { validateProductionConfig } from "../apps/control-plane/src/config.ts";
import { assert, equal, group, report, test, throws } from "./harness.ts";

process.env.KAPI_PGLITE_DIR = "memory://operations-test";
const handle = await createDb("");
await truncateAll(handle);
const store = new Store(handle);
await handle.raw(
  `INSERT INTO users (id,workos_id,email,name) VALUES ('usr_ops','ops-test','ops@test.local','Ops')`,
);
const project = await store.createProject({
  ownerId: "usr_ops", name: "operations", repoUrl: "https://github.com/kapi/ops.git",
});

group("database safety");

await test("whole-database truncation requires an explicit external opt-in", async () => {
  let statements = 0;
  const external = {
    embedded: false,
    exec: async () => { statements++; },
  } as unknown as DbHandle;
  await throws(() => truncateAll(external), "external truncation is refused");
  equal(statements, 0, "the guard stops before executing SQL");
  await truncateAll(external, { allowExternal: true });
  equal(statements, 1, "the reset CLI can opt in after its own confirmation");
});

group("production configuration");

const productionApiEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgres://database.invalid/kapi",
  KAPI_SECRET_KEY: Buffer.alloc(32, 4).toString("base64"),
  KAPI_SESSION_SECRET: "a-session-secret-that-is-at-least-32-characters",
  KAPI_ALLOWED_ORIGINS: "https://app.example.com",
  KAPI_WEB_URL: "https://app.example.com",
  CONTROL_PLANE_PUBLIC_URL: "https://api.example.com",
  WORKOS_CLIENT_ID: "client_test",
  WORKOS_API_KEY: "sk_test",
  WORKOS_REDIRECT_URI: "https://api.example.com/auth/callback",
  KAPI_METRICS_TOKEN: "metrics-test-token",
  GITHUB_WEBHOOK_SECRET: "webhook-test-secret",
  KAPI_OPERATIONS: "off",
});

await test("a complete production API configuration passes validation", () => {
  validateProductionConfig("api", productionApiEnv());
});

await test("production never exposes unsigned metrics or GitHub webhooks", async () => {
  const noMetrics = productionApiEnv();
  delete noMetrics.KAPI_METRICS_TOKEN;
  await throws(() => validateProductionConfig("api", noMetrics), "metrics token is required");

  const unsignedGithub: NodeJS.ProcessEnv = {
    ...productionApiEnv(), GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "encoded-key",
  };
  delete unsignedGithub.GITHUB_WEBHOOK_SECRET;
  await throws(
    () => validateProductionConfig("api", unsignedGithub),
    "a configured GitHub App requires webhook signatures",
  );
});

await test("production URLs, origins, and encryption keys are hardened", async () => {
  await throws(
    () => validateProductionConfig("api", { ...productionApiEnv(), KAPI_WEB_URL: "http://app.example.com" }),
    "plain HTTP web URL",
  );
  await throws(
    () => validateProductionConfig("api", {
      ...productionApiEnv(), KAPI_ALLOWED_ORIGINS: "https://other.example.com",
    }),
    "the deployed web origin must be allowed",
  );
  await throws(
    () => validateProductionConfig("api", { ...productionApiEnv(), KAPI_SECRET_KEY: "too-short" }),
    "the vault key must be 256-bit",
  );
});

group("scheduler");

await test("cron occurrences honor an IANA timezone and invalid zones fail", async () => {
  const next = nextOccurrence("0 9 * * *", "Asia/Kolkata", new Date("2026-01-01T00:00:00Z"));
  equal(next.toISOString(), "2026-01-01T03:30:00.000Z", "09:00 IST");
  await throws(() => nextOccurrence("0 9 * * *", "Mars/Olympus"), "invalid timezone");
});

const runs = new RunService(handle, store);
const schedulerA = new Scheduler(handle, store, runs);
const schedulerB = new Scheduler(handle, store, runs);
let scheduleId = "";

await test("two schedulers create one run for one occurrence", async () => {
  const schedule = await schedulerA.create(project, {
    name: "daily", cron: "0 9 * * *", timezone: "UTC", goal: "inspect the repository",
  });
  scheduleId = schedule.id;
  await handle.raw(`UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [schedule.id]);
  const before = new Date();
  await Promise.all([schedulerA.tick(1, before), schedulerB.tick(1, before)]);
  const rows = await handle.raw<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE schedule_id=$1`, [schedule.id]);
  equal(Number(rows[0]?.n), 1, "exactly one scheduled run");
  const listed = await schedulerA.list(project.id);
  equal(listed[0]?.threadId, schedule.threadId, "the schedule owns one dedicated thread");
});

await test("an active scheduled run makes the next occurrence skip", async () => {
  await handle.raw(`UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [scheduleId]);
  const result = await schedulerA.tick(1, new Date());
  equal(result.skipped.length, 1, "overlap skipped");
  const rows = await handle.raw<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE schedule_id=$1`, [scheduleId]);
  equal(Number(rows[0]?.n), 1, "no second run");
});

await test("a scheduled captain can review work and close the dedicated thread", async () => {
  const runRows = await handle.raw<{ id: string }>(
    `SELECT id FROM runs WHERE schedule_id=$1 ORDER BY created_at LIMIT 1`, [scheduleId],
  );
  const runId = runRows[0]!.id;
  const root = (await listJobs(handle, runId)).find((job) => job.parentJobId === null)!;
  await claim(handle, { vmId: "vm-captain", jobId: root.id, runId });
  await markRunning(handle, root.id, "vm-captain");
  const review = await enqueue(handle, {
    runId, parentJobId: root.id, kind: "review", role: "review",
    instruction: "review the scheduled work", acceptance: ["safe"], touches: [],
    dependsOn: [], priority: 1, maxAttempts: 1, context: {},
  });
  await claim(handle, { vmId: "vm-review", jobId: review.id, runId });
  await markRunning(handle, review.id, "vm-review");
  await complete(handle, review.id, "vm-review", {
    ok: true, summary: "review approved", filesChanged: [], commits: [],
    review: { decision: "approve", summary: "safe", findings: [], acceptanceMet: [true] },
  });
  const captain = await complete(handle, root.id, "vm-captain", {
    ok: true, summary: "scheduled review completed", filesChanged: [], commits: [],
  });
  await createRunLifecycle({ handle, store }).finishRun(captain!);
  equal((await store.getRun(runId))?.status, "completed", "scheduled run completed");
  equal((await schedulerA.list(project.id))[0]?.lastStatus, "completed", "schedule records outcome");
});

await test("concurrent manual triggers also obey the overlap lock", async () => {
  const results = await Promise.all([
    schedulerA.runNow(scheduleId, project.ownerId),
    schedulerB.runNow(scheduleId, project.ownerId),
  ]);
  equal(results.filter((result) => result?.run).length, 1, "one manual run started");
  equal(results.filter((result) => result?.skipped).length, 1, "the racing trigger skipped");
});

group("usage accounting");

await test("VM seconds and known cost settle once across repeated passes", async () => {
  process.env.KAPI_TEST_CENTS_PER_HOUR = "360"; // one tenth cent per second
  const thread = await store.createThread(project.id, "metering");
  const started = await runs.start({ thread, project, goal: "meter this" });
  const end = new Date("2026-01-01T00:00:05Z");
  await handle.raw(
    `INSERT INTO agents (job_id,run_id,role,status,vm_id,provider,accounted_through,started_at,stopped_at)
     VALUES ($1,$2,'captain','succeeded','vm-meter','test',$3,$3,$4)`,
    [started.job.id, started.run.id, new Date("2026-01-01T00:00:00Z"), end],
  );
  const accounting = new UsageAccounting(handle);
  const first = await accounting.settle(end);
  equal(first.vmSeconds, 5, "five seconds accounted");
  const second = await accounting.settle(end);
  equal(second.vmSeconds, 0, "replay is idempotent");
  const run = await store.getRun(started.run.id);
  equal(run?.vmSeconds, 5, "aggregate is exact");
  equal(run?.costStatus, "known", "explicit provider rate is authoritative");
  assert((run?.usdMicros ?? 0) > 0, "cost is retained below one-cent precision");
});

group("VM reconciliation");

class FakeProvider implements VmProvider {
  readonly name = "fake";
  resources: ManagedVm[] = [];
  destroyed: string[] = [];
  async isAvailable() { return true; }
  async create(spec: VmSpec): Promise<Vm> { return { id: newId("vm"), provider: this.name, workdir: "/tmp", createdAt: Date.now(), metadata: spec.metadata }; }
  async exec() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; }
  async *execStream() { /* no output */ }
  async writeFile() {} async readFile() { return ""; } async spawnDetached() {} async destroy() {}
  async destroyOrphan(id: string) { this.destroyed.push(id); return true; }
  async listManaged() { return this.resources; }
}

await test("only labelled resources with KAPI ownership metadata are deleted", async () => {
  const provider = new FakeProvider();
  provider.resources = [
    { id: "owned-orphan", provider: "fake", workdir: "/tmp", createdAt: 0, managed: true,
      metadata: { jobId: "job_gone", runId: "run_gone" } },
    { id: "unowned", provider: "fake", workdir: "/tmp", createdAt: 0, managed: true, metadata: {} },
  ];
  const audit = new VmReconciler(handle, provider, 60_000, 0, true);
  const preview = await audit.reconcile();
  equal(preview.orphaned, 1, "one owned orphan detected");
  equal(provider.destroyed.length, 0, "audit mode does not delete");
  const active = new VmReconciler(handle, provider, 60_000, 0, false);
  await active.reconcile();
  equal(provider.destroyed.join(","), "owned-orphan", "unowned resource protected");
});

await test("a provider-reported stopped VM releases its active agent row", async () => {
  const provider = new FakeProvider();
  const thread = await store.createThread(project.id, "stopped resource");
  const started = await runs.start({ thread, project, goal: "detect stopped VM" });
  await handle.raw(
    `INSERT INTO agents (job_id,run_id,role,status,vm_id,provider,last_heartbeat)
     VALUES ($1,$2,'captain','provisioning','vm-stopped','fake',now())`,
    [started.job.id, started.run.id],
  );
  provider.resources = [{
    id: "vm-stopped", provider: "fake", workdir: "/tmp", createdAt: Date.now(),
    managed: true, status: "stopped",
    metadata: { jobId: started.job.id, runId: started.run.id },
  }];

  const result = await new VmReconciler(handle, provider, 60_000, 0, true).reconcile();
  equal(result.missing, 1, "the stopped resource is treated as unavailable");
  const rows = await handle.raw<{ status: string; stopped_at: string | null }>(
    `SELECT status,stopped_at FROM agents WHERE job_id=$1`, [started.job.id],
  );
  equal(rows[0]?.status, "resource-stopped", "the reason is retained");
  assert(rows[0]?.stopped_at != null, "the reservation is released");
});

await handle.close();
report();
