import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Authenticator, mintJobToken } from "@kapi/identity";
import { claim, complete, enqueue, getJob, reap } from "@kapi/queue";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { createRunLifecycle } from "../apps/control-plane/src/run-lifecycle.ts";
import { attachWebSocket } from "../apps/control-plane/src/ws.ts";
import { assert, equal, group, report, sleep, test } from "./harness.ts";
import { createTestDb, useHermeticTestConfig } from "./test-db.ts";

useHermeticTestConfig();
if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
}

const testDb = await createTestDb("control_plane");
const { handle } = testDb;
console.log(`\n  database: ${handle.target}`);

const store = new Store(handle);
const hub = new EventHub(store, handle, 250);
const auth = new Authenticator(handle);
const app = createApp({ handle, store, hub, auth, githubApp: null });

const server = serve({ fetch: app.fetch, port: 0 });
// The same wiring index.ts uses - the websocket tests below exercise the real
// upgrade path, not a stand-in.
const wss = attachWebSocket(server, hub, { auth, store });
await new Promise((r) => setTimeout(r, 150));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`  server:   ${base}`);

type Res<T> = { status: number; body: T };
async function api<T>(
  method: string, path: string, body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

/* ------------------------------------------------------------------ */

group("health and identity");

await test("health reports the plane's real configuration", async () => {
  const { status, body } = await api<Record<string, unknown>>("GET", "/api/health");
  equal(status, 200, "health is reachable");
  assert(body.ok === true, "ok");
  assert(body.auth === "dev" || body.auth === "workos", `auth mode present: ${body.auth}`);
  assert(typeof body.queueDepth === "number", "queue depth is reported");
  assert(String(body.vault).startsWith("configured"), `vault configured, got ${body.vault}`);
});

await test("an unconfigured WorkOS falls back to a named dev user", async () => {
  const { status, body } = await api<{ userId: string; via: string; email?: string }>("GET", "/api/me");
  equal(status, 200, "identified");
  equal(body.via, "dev", "the mode is stated, not hidden");
  assert(body.userId.startsWith("usr_"), "a real user row was created");
});

await test("setup reports safe readiness metadata without credentials", async () => {
  const { status, body } = await api<{
    auth: { mode: string }; vault: { configured: boolean }; vm: { provider: string };
    github: { configured: boolean };
    codex: { connected: boolean; status: string; accountId: string | null };
  }>("GET", "/api/setup");
  equal(status, 200, "setup is readable by its owner");
  equal(body.auth.mode, "dev", "auth mode is explicit");
  equal(body.vault.configured, true, "vault readiness is safe metadata");
  equal(body.github.configured, false, "GitHub configuration is explicit");
  equal(body.codex.connected, false, "missing Codex grant is actionable");
  assert(!("accessToken" in body.codex), "no credential leaves the API");
});

await test("Codex connection rejects an off-site return URL", async () => {
  const result = await api("POST", "/api/connections/codex/start", {
    returnTo: "https://attacker.example/steal",
  });
  equal(result.status, 400, "open redirects are refused");
});

/* ------------------------------------------------------------------ */

group("projects and threads");

let projectId = "";
let threadId = "";

await test("a project can be created and read back", async () => {
  const created = await api<{ id: string; name: string; defaultBranch: string }>(
    "POST", "/api/projects",
    { name: "kapi test", repoUrl: "https://github.com/kapi/test.git" },
  );
  equal(created.status, 201, "created");
  equal(created.body.defaultBranch, "main", "branch defaulted");
  projectId = created.body.id;

  const listed = await api<Array<{ id: string }>>("GET", "/api/projects");
  assert(listed.body.some((p) => p.id === projectId), "appears in the listing");
});

await test("an invalid repo url is rejected", async () => {
  const res = await api("POST", "/api/projects", { name: "bad", repoUrl: "not-a-url" });
  equal(res.status, 400, "rejected before anything is written");
});

await test("a thread belongs to its project", async () => {
  const created = await api<{ id: string; projectId: string }>(
    "POST", `/api/projects/${projectId}/threads`, { title: "first" },
  );
  equal(created.status, 201, "created");
  equal(created.body.projectId, projectId, "linked to the project");
  threadId = created.body.id;

  const detail = await api<{ project: { id: string }; threads: Array<{ id: string }> }>(
    "GET", `/api/projects/${projectId}`,
  );
  assert(detail.body.threads.some((t) => t.id === threadId), "listed on the project");
});

await test("another user's project is a 404, not a 403", async () => {
  // Ownership is scoped in the query, so a project you do not own is
  // indistinguishable from one that does not exist.
  const res = await api("GET", "/api/projects/prj_does_not_exist");
  equal(res.status, 404, "not found");
});

await test("project integration readiness is scoped and actionable", async () => {
  const found = await api<{
    github: { configured: boolean; installed: boolean; action: string; reason: string };
  }>("GET", `/api/projects/${projectId}/integrations`);
  equal(found.status, 200, "project owner can inspect readiness");
  equal(found.body.github.configured, false, "missing app is explicit");
  equal(found.body.github.installed, false, "repository is not falsely ready");
  assert(found.body.github.reason.length > 0, "the UI receives an action message");

  const missing = await api("GET", "/api/projects/prj_does_not_exist/integrations");
  equal(missing.status, 404, "another project cannot be inspected");
});

group("schedules API");

let scheduleId = "";
await test("a schedule owns a dedicated thread and validates its timezone", async () => {
  const bad = await api("POST", `/api/projects/${projectId}/schedules`, {
    name: "bad", cron: "0 9 * * *", timezone: "Moon/Base", goal: "never",
  });
  equal(bad.status, 400, "invalid timezone rejected");
  const created = await api<{ id: string; threadId: string; nextRunAt: string }>(
    "POST", `/api/projects/${projectId}/schedules`, {
      name: "weekday review", cron: "0 9 * * 1-5", timezone: "Asia/Kolkata",
      goal: "review repository health",
    },
  );
  equal(created.status, 201, "created");
  assert(created.body.threadId.startsWith("thr_"), "dedicated thread created");
  assert(Boolean(created.body.nextRunAt), "next occurrence calculated");
  scheduleId = created.body.id;
});

await test("schedules can pause, resume, and run without overlap", async () => {
  const paused = await api<{ enabled: boolean; nextRunAt: string | null }>(
    "PATCH", `/api/schedules/${scheduleId}`, { enabled: false },
  );
  equal(paused.body.enabled, false, "paused");
  equal(paused.body.nextRunAt, null, "no occurrence while paused");
  const resumed = await api<{ enabled: boolean }>("PATCH", `/api/schedules/${scheduleId}`, { enabled: true });
  equal(resumed.body.enabled, true, "resumed");
  const first = await api<{ run: { id: string } }>("POST", `/api/schedules/${scheduleId}/run`);
  equal(first.status, 202, "manual occurrence started");
  const second = await api("POST", `/api/schedules/${scheduleId}/run`);
  equal(second.status, 409, "overlap skipped");
  await api("POST", `/api/runs/${first.body.run.id}/cancel`);
});

/* ------------------------------------------------------------------ */

group("a message starts a run");

let runId = "";
let captainJobId = "";

await test("posting a message opens a run and queues a root captain job", async () => {
  const res = await api<{
    message: { id: string; role: string }; run: { id: string; status: string; goal: string };
    job: { id: string; kind: string; role: string; status: string; parentJobId: string | null };
  }>("POST", `/api/threads/${threadId}/messages`, { content: "add a /health endpoint" });

  equal(res.status, 202, "accepted");
  equal(res.body.message.role, "user", "the turn is recorded");
  equal(res.body.run.goal, "add a /health endpoint", "the goal is the message");
  equal(res.body.job.kind, "captain", "a captain job, not a plan");
  equal(res.body.job.status, "queued", "queued for a VM to claim");
  equal(res.body.job.parentJobId, null, "it is the root of the spawn tree");

  runId = res.body.run.id;
  captainJobId = res.body.job.id;
});

await test("the queued captain is claimable by a VM", async () => {
  // Phase 2 supplies the VM. What matters here is that the control plane left
  // work in a state something can come and take.
  const claimed = await claim(handle, { vmId: "test-vm", runId, kinds: ["captain"] });
  assert(claimed?.id === captainJobId, "the captain job was claimable");
  equal(claimed!.payload.instruction, "add a /health endpoint", "instruction carried through");
  equal(
    (claimed!.payload.context as { repoUrl?: string }).repoUrl,
    "https://github.com/kapi/test.git",
    "repo context travels with the job",
  );
});

await test("the run detail assembles jobs and events", async () => {
  const res = await api<{
    run: { id: string }; jobs: Array<{ id: string }>; events: Array<{ seq: number; kind: string }>;
  }>("GET", `/api/runs/${runId}`);
  equal(res.status, 200, "readable");
  equal(res.body.run.id, runId, "the run");
  assert(res.body.jobs.some((j) => j.id === captainJobId), "its jobs");
  assert(res.body.events.length >= 2, `its events (queued + claimed), got ${res.body.events.length}`);
  assert(res.body.events.every((e, i) => e.seq === i + 1), "events are ordered and gap-free");
});

await test("cancelling a run cancels the captain's whole subtree", async () => {
  const res = await api<{ cancelled: number }>("POST", `/api/runs/${runId}/cancel`);
  equal(res.status, 200, "cancelled");
  assert(res.body.cancelled >= 1, "at least the captain");
  equal((await getJob(handle, captainJobId))?.status, "cancelled", "the claimed captain was cancelled");
});

/* ------------------------------------------------------------------ */

group("live stream");

await test("a websocket replays history then delivers new events live", async () => {
  const thread = await api<{ id: string }>("POST", `/api/projects/${projectId}/threads`, {});
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Array<Record<string, unknown>> = [];
  socket.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((r) => { socket.onopen = () => r(null); });

  const started = await api<{ run: { id: string } }>(
    "POST", `/api/threads/${thread.body.id}/messages`, { content: "second run" },
  );

  for (let i = 0; i < 40 && frames.filter((f) => f.kind === "event").length < 1; i++) {
    await sleep(100);
  }
  socket.close();

  const events = frames
    .filter((f) => f.kind === "event")
    .map((f) => f.event as { runId: string; kind: string; seq: number });
  const forRun = events.filter((e) => e.runId === started.body.run.id);
  assert(forRun.length >= 1, `expected events for the new run, saw ${events.length} total`);
  assert(forRun.some((e) => e.kind === "job.status"), "the captain being queued was streamed");
});

await test("a cursor resumes without replaying what the client already has", async () => {
  const detail = await api<{ events: Array<{ seq: number }> }>("GET", `/api/runs/${runId}`);
  const total = detail.body.events.length;
  assert(total >= 2, "the run has history to resume from");

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=${runId}&cursor=${total}`);
  const frames: Array<Record<string, unknown>> = [];
  socket.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((r) => { socket.onopen = () => r(null); });

  for (let i = 0; i < 30 && !frames.some((f) => f.kind === "replayed"); i++) await sleep(100);
  socket.close();

  const replayed = frames.find((f) => f.kind === "replayed") as { count: number; cursor: number } | undefined;
  assert(replayed, "the server acknowledged the resume");
  equal(replayed!.count, 0, "nothing before the cursor was re-sent");
  equal(replayed!.cursor, total, "the cursor held");
});

await test("connecting with cursor 0 replays the whole run", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=${runId}&cursor=0`);
  const frames: Array<Record<string, unknown>> = [];
  socket.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((r) => { socket.onopen = () => r(null); });
  for (let i = 0; i < 30 && !frames.some((f) => f.kind === "replayed"); i++) await sleep(100);
  socket.close();

  const replayed = frames.find((f) => f.kind === "replayed") as { count: number } | undefined;
  assert(replayed && replayed.count >= 2, `full history replayed, got ${replayed?.count}`);
});

await test("a socket cannot subscribe to a run it does not own or that does not exist", async () => {
  const opened = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?runId=run_not_owned`);
    socket.onopen = () => { socket.close(); resolve(true); };
    socket.onerror = () => resolve(false);
    socket.onclose = () => resolve(false);
  });
  equal(opened, false, "upgrade rejected before replay");
});

/* ------------------------------------------------------------------ */

group("run lifecycle");

// The same object index.ts wires into the reaper, so these tests cover the
// production path rather than a stand-in for it.
const lifecycle = createRunLifecycle({ handle, store });

/** A thread of its own per test: the groups above hold module-level ids. */
async function freshRun(goal: string): Promise<{ runId: string; jobId: string }> {
  const thread = await api<{ id: string }>("POST", `/api/projects/${projectId}/threads`, {});
  const started = await api<{ run: { id: string }; job: { id: string } }>(
    "POST", `/api/threads/${thread.body.id}/messages`, { content: goal },
  );
  return { runId: started.body.run.id, jobId: started.body.job.id };
}

const runStatusEvents = async (id: string, status: string) => {
  const events = await store.listEvents(id, 0);
  return events.filter((e) => e.kind === "run.status" && e.payload.status === status);
};

const startAgent = async (runId: string, jobId: string, vmId: string) => {
  const token = mintJobToken({ jobId, runId, vmId });
  return fetch(`${base}/agent/start`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
};

await test("starting an agent moves the run from queued to running", async () => {
  const { runId: id, jobId } = await freshRun("open the run");
  equal((await store.getRun(id))?.status, "queued", "a run starts queued");

  await claim(handle, { vmId: "vm-open", jobId, runId: id });
  await startAgent(id, jobId, "vm-open");

  equal((await store.getRun(id))?.status, "running", "the run is running once an agent is");
  equal((await runStatusEvents(id, "running")).length, 1, "and it said so exactly once");
});

await test("a second agent starting does not re-announce the run as running", async () => {
  const { runId: id, jobId } = await freshRun("announce once");
  await claim(handle, { vmId: "vm-a", jobId, runId: id });
  await startAgent(id, jobId, "vm-a");

  // A captain spawns freely, and every one of its children starts. The
  // transition has to be idempotent or the stream fills with noise.
  const child = await enqueue(handle, {
    runId: id, parentJobId: jobId, kind: "build", role: "backend",
    instruction: "a child that also starts", acceptance: [], touches: [],
    dependsOn: [], priority: 0, maxAttempts: 3, context: {},
  });
  await claim(handle, { vmId: "vm-b", jobId: child.id, runId: id });
  await startAgent(id, child.id, "vm-b");

  equal((await runStatusEvents(id, "running")).length, 1, "still exactly one running event");
});

await test("a cancelled run is never walked back to running", async () => {
  const { runId: id, jobId } = await freshRun("cancel before starting");
  await api("POST", `/api/runs/${id}/cancel`);

  await claim(handle, { vmId: "vm-late", jobId, runId: id });
  await startAgent(id, jobId, "vm-late");

  equal((await store.getRun(id))?.status, "cancelled", "cancelled is final");
  equal((await runStatusEvents(id, "running")).length, 0, "and nothing announced otherwise");
});

await test("a dead-lettered root captain finishes its run", async () => {
  const { runId: id, jobId } = await freshRun("lose the captain");
  // The message route hardcodes three attempts; one makes the next reap final.
  await handle.raw(`UPDATE jobs SET max_attempts = 1 WHERE id = $1`, [jobId]);
  await claim(handle, { vmId: "vm-doomed", jobId, runId: id, leaseSeconds: 1 });

  await sleep(1200);
  const reaped = await reap(handle);
  const dead = reaped.find((j) => j.id === jobId);
  equal(dead?.status, "failed", "the reaper dead-lettered the captain");

  await lifecycle.onReap(reaped);

  const run = await store.getRun(id);
  equal(run?.status, "failed", "the run ended with the captain that was driving it");
  assert(run?.finishedAt !== null, "and it has a finish time");
  equal((await runStatusEvents(id, "failed")).length, 1, "the stream says so once");

  // The user-visible half: a thread that can only be talked into is not a
  // conversation. Without this the run simply goes quiet forever.
  const thread = await store.getRun(id).then((r) => r!.threadId);
  const messages = await store.listMessages(thread);
  assert(
    messages.some((m) => m.role === "captain"),
    "the thread was answered rather than left hanging",
  );
});

await test("a requeued root does not finish its run", async () => {
  const { runId: id, jobId } = await freshRun("survive one lost VM");
  // Attempts remain, so this reap requeues rather than dead-letters - and a run
  // that announced itself failed and then carried on would be worse than one
  // that said nothing.
  await claim(handle, { vmId: "vm-flaky", jobId, runId: id, leaseSeconds: 1 });

  await sleep(1200);
  const reaped = await reap(handle);
  equal(reaped.find((j) => j.id === jobId)?.status, "queued", "back on the queue, not dead");

  await lifecycle.onReap(reaped);

  const run = await store.getRun(id);
  assert(run?.status !== "failed", `the run is still alive, got ${run?.status}`);
  equal(run?.finishedAt, null, "and has no finish time");
});

await test("a finished root cancels every unfinished descendant", async () => {
  const { runId: id, jobId } = await freshRun("close the whole fleet");
  await claim(handle, { vmId: "vm-root-finish", jobId, runId: id });
  const child = await enqueue(handle, {
    runId: id, parentJobId: jobId, kind: "build", role: "backend",
    instruction: "still working", acceptance: [], touches: [], dependsOn: [],
    priority: 0, maxAttempts: 3, context: {},
  });
  const grandchild = await enqueue(handle, {
    runId: id, parentJobId: child.id, kind: "review", role: "review",
    instruction: "queued behind it", acceptance: [], touches: [], dependsOn: [],
    priority: 0, maxAttempts: 3, context: {},
  });
  await handle.raw(
    `INSERT INTO agents (job_id,run_id,role,status,vm_id,last_heartbeat)
     VALUES ($1,$3,'backend','running','vm-child',now()),
            ($2,$3,'review','provisioning','vm-grandchild',now())`,
    [child.id, grandchild.id, id],
  );

  const root = await complete(handle, jobId, "vm-root-finish", {
    ok: true, summary: "fleet result is final", filesChanged: [], commits: [],
  });
  await lifecycle.finishRun(root!);

  equal((await getJob(handle, child.id))?.status, "cancelled", "running child stopped");
  equal((await getJob(handle, grandchild.id))?.status, "cancelled", "queued grandchild stopped");
  const live = await handle.raw<{ n: number }>(
    `SELECT count(*)::int AS n FROM agents WHERE job_id=ANY($1::text[]) AND stopped_at IS NULL`,
    [[child.id, grandchild.id]],
  );
  equal(Number(live[0]?.n), 0, "no descendant agent remains live");
  const events = await store.listEvents(id, 0);
  equal(
    events.filter((event) => event.kind === "job.status" && event.payload.status === "cancelled").length,
    2,
    "each forced cancellation is visible in the event stream",
  );
});

/* ------------------------------------------------------------------ */

group("GitHub check webhooks");

// Use a live fleet for privileged inbox calls. Earlier coverage deliberately
// cancels the module-level run, and a cancelled captain's token must stay dead.
const webhookFleet = await freshRun("receive CI results");
await claim(handle, {
  vmId: "vm-webhook-captain", jobId: webhookFleet.jobId, runId: webhookFleet.runId,
});

await test("a completed check lands once in the correlated run and captain inbox", async () => {
  const payload = {
    action: "completed",
    repository: { full_name: "kapi/test" },
    sender: { login: "github-actions[bot]" },
    installation: { id: 42 },
    check_run: {
      id: 1001,
      name: "unit tests",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      details_url: "https://github.com/kapi/test/actions/runs/1",
      check_suite: { id: 501, head_branch: `kapi/${webhookFleet.jobId}`, head_sha: "abc123" },
    },
  };

  const deliver = () => fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-github-delivery": "delivery-check-1001",
    },
    body: JSON.stringify(payload),
  });

  const first = await deliver();
  equal(first.status, 200, "the completed check was accepted");
  const second = await deliver();
  equal(second.status, 200, "a GitHub retry was accepted idempotently");

  const detail = await api<{ events: Array<{
    kind: string; to: string | null; payload: Record<string, unknown>;
  }> }>("GET", `/api/runs/${webhookFleet.runId}`);
  const ci = detail.body.events.filter((event) =>
    event.kind === "ci.completed" && event.payload.deliveryId === "delivery-check-1001"
  );
  equal(ci.length, 1, "one stream event was written for the delivery");
  equal(ci[0]!.to, "captain", "the root captain is the event recipient");
  equal(ci[0]!.payload.conclusion, "success", "the conclusion is preserved");

  const token = mintJobToken({
    jobId: webhookFleet.jobId, runId: webhookFleet.runId, vmId: "vm-webhook-captain",
  });
  const inbox = await fetch(`${base}/agent/inbox?after=0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  equal(inbox.status, 200, "the captain inbox is readable");
  const messages = await inbox.json() as {
    messages: Array<{
      from: string; kind: string; content: string; payload: Record<string, unknown>;
    }>;
  };
  assert(
    messages.messages.some((message) =>
      message.from === "orchestrator" && message.payload.deliveryId === "delivery-check-1001" &&
      message.content.includes("unit tests completed with success")
    ),
    "the captain receives the CI completion without polling GitHub",
  );
});

await test("an inbox message carries the kind of event it came from", async () => {
  // A worker's question and a CI result arrive through the same inbox and
  // demand opposite responses - one blocks an agent until answered, the other
  // cannot be replied to at all. Without the kind they are indistinguishable.
  const child = await enqueue(handle, {
    runId: webhookFleet.runId, parentJobId: webhookFleet.jobId, kind: "build", role: "backend",
    instruction: "ask something", acceptance: [], touches: [],
    dependsOn: [], priority: 0, maxAttempts: 3, context: {},
  });
  await claim(handle, { vmId: "vm-asker", jobId: child.id, runId: webhookFleet.runId });
  const childToken = mintJobToken({ jobId: child.id, runId: webhookFleet.runId, vmId: "vm-asker" });
  await fetch(`${base}/agent/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${childToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ kind: "agent.message", to: "captain", payload: { content: "which branch?" } }],
    }),
  });

  const token = mintJobToken({
    jobId: webhookFleet.jobId, runId: webhookFleet.runId, vmId: "vm-webhook-captain",
  });
  const res = await fetch(`${base}/agent/inbox?after=0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { messages } = await res.json() as {
    messages: Array<{ from: string; kind: string; content: string }>;
  };

  assert(
    messages.some((m) => m.kind === "ci.completed" && m.from === "orchestrator"),
    "the CI result is labelled as what it is",
  );
  assert(
    messages.some((m) => m.kind === "agent.message" && m.content === "which branch?"),
    "and a worker's question is labelled separately",
  );
});

await test("a non-completed check is ignored", async () => {
  const res = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "check_suite" },
    body: JSON.stringify({
      action: "requested",
      repository: { full_name: "kapi/test" },
      check_suite: { id: 502, status: "queued", head_branch: `kapi/${webhookFleet.jobId}` },
    }),
  });
  equal(res.status, 202, "an in-progress suite does not write completion state");
});

/* ------------------------------------------------------------------ */

group("secrets");

await test("a secret goes in and never comes back out", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const put = await api<{ id: string; name: string }>("PUT", "/api/secrets", {
    scope: "user", scopeId: me.body.userId, name: "TEST_SERVICE_TOKEN", value: "super-secret-value",
  });
  equal(put.status, 201, "stored");
  assert(!JSON.stringify(put.body).includes("super-secret-value"), "the write response carries no plaintext");

  const listed = await api<Array<{ name: string }>>(
    "GET", `/api/secrets?scope=user&scopeId=${me.body.userId}`,
  );
  assert(listed.body.some((s) => s.name === "TEST_SERVICE_TOKEN"), "listed by name");
  assert(!JSON.stringify(listed.body).includes("super-secret-value"), "the listing carries no plaintext");
});

await test("the stored value is encrypted at rest", async () => {
  const rows = await handle.raw<{ ciphertext: string; iv: string; tag: string }>(
    `SELECT ciphertext, iv, tag FROM secrets WHERE name = 'TEST_SERVICE_TOKEN'`,
  );
  const row = rows[0];
  assert(row, "the row exists");
  assert(!row!.ciphertext.includes("super-secret"), "the column is not plaintext");
  assert(row!.iv.length > 0 && row!.tag.length > 0, "AES-GCM envelope is complete");
});

await test("resolve reads it back, narrowest scope winning", async () => {
  const { resolve } = await import("@kapi/identity");
  const me = await api<{ userId: string }>("GET", "/api/me");

  const atUser = await resolve(handle, "TEST_SERVICE_TOKEN", { userId: me.body.userId });
  equal(atUser?.value, "super-secret-value", "round-trips through AES-GCM");
  equal(atUser?.scope, "user", "found at user scope");

  await api("PUT", "/api/secrets", {
    scope: "project", scopeId: projectId, name: "TEST_SERVICE_TOKEN", value: "project-value",
  });
  const atProject = await resolve(handle, "TEST_SERVICE_TOKEN", {
    userId: me.body.userId, projectId,
  });
  equal(atProject?.value, "project-value", "the project key overrides the user's");
  equal(atProject?.scope, "project", "and reports which scope it came from");
});

await test("a secret cannot be written into someone else's scope", async () => {
  const res = await api("PUT", "/api/secrets", {
    scope: "project", scopeId: "prj_not_mine", name: "TEST_SERVICE_TOKEN", value: "x",
  });
  equal(res.status, 404, "refused");
});

await test("a lowercase secret name is rejected", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const res = await api("PUT", "/api/secrets", {
    scope: "user", scopeId: me.body.userId, name: "lowercase_token", value: "x",
  });
  equal(res.status, 400, "names must be env-var shaped");
});

await test("a secret can be deleted", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const res = await api<{ deleted: boolean }>(
    "DELETE", `/api/secrets/user/${me.body.userId}/TEST_SERVICE_TOKEN`,
  );
  equal(res.status, 200, "deleted");
  const listed = await api<Array<{ name: string }>>(
    "GET", `/api/secrets?scope=user&scopeId=${me.body.userId}`,
  );
  assert(!listed.body.some((s) => s.name === "TEST_SERVICE_TOKEN"), "gone from the listing");
});

wss.close();
await hub.close();
await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
await testDb.close();
report();
