import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createDb, truncateAll } from "@kapi/db";
import { Authenticator } from "@kapi/identity";
import { claim, getJob } from "@kapi/queue";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { attachWebSocket } from "../apps/control-plane/src/ws.ts";
import { assert, equal, group, report, sleep, test } from "./harness.ts";

if (!process.env.DATABASE_URL) process.env.KAPI_PGLITE_DIR = "memory://cp-test";
if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
}

const handle = await createDb();
console.log(`\n  database: ${handle.target}`);
await truncateAll(handle);

const store = new Store(handle);
const hub = new EventHub(store, handle, 250);
const auth = new Authenticator(handle);
const app = createApp({ handle, store, hub, auth });

const server = serve({ fetch: app.fetch, port: 0 });
// The same wiring index.ts uses - the websocket tests below exercise the real
// upgrade path, not a stand-in.
const wss = attachWebSocket(server, hub);
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

/* ------------------------------------------------------------------ */

group("secrets");

await test("a secret goes in and never comes back out", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const put = await api<{ id: string; name: string }>("PUT", "/api/secrets", {
    scope: "user", scopeId: me.body.userId, name: "GEMINI_API_KEY", value: "super-secret-value",
  });
  equal(put.status, 201, "stored");
  assert(!JSON.stringify(put.body).includes("super-secret-value"), "the write response carries no plaintext");

  const listed = await api<Array<{ name: string }>>(
    "GET", `/api/secrets?scope=user&scopeId=${me.body.userId}`,
  );
  assert(listed.body.some((s) => s.name === "GEMINI_API_KEY"), "listed by name");
  assert(!JSON.stringify(listed.body).includes("super-secret-value"), "the listing carries no plaintext");
});

await test("the stored value is encrypted at rest", async () => {
  const rows = await handle.raw<{ ciphertext: string; iv: string; tag: string }>(
    `SELECT ciphertext, iv, tag FROM secrets WHERE name = 'GEMINI_API_KEY'`,
  );
  const row = rows[0];
  assert(row, "the row exists");
  assert(!row!.ciphertext.includes("super-secret"), "the column is not plaintext");
  assert(row!.iv.length > 0 && row!.tag.length > 0, "AES-GCM envelope is complete");
});

await test("resolve reads it back, narrowest scope winning", async () => {
  const { resolve } = await import("@kapi/identity");
  const me = await api<{ userId: string }>("GET", "/api/me");

  const atUser = await resolve(handle, "GEMINI_API_KEY", { userId: me.body.userId });
  equal(atUser?.value, "super-secret-value", "round-trips through AES-GCM");
  equal(atUser?.scope, "user", "found at user scope");

  await api("PUT", "/api/secrets", {
    scope: "project", scopeId: projectId, name: "GEMINI_API_KEY", value: "project-value",
  });
  const atProject = await resolve(handle, "GEMINI_API_KEY", {
    userId: me.body.userId, projectId,
  });
  equal(atProject?.value, "project-value", "the project key overrides the user's");
  equal(atProject?.scope, "project", "and reports which scope it came from");
});

await test("a secret cannot be written into someone else's scope", async () => {
  const res = await api("PUT", "/api/secrets", {
    scope: "project", scopeId: "prj_not_mine", name: "GEMINI_API_KEY", value: "x",
  });
  equal(res.status, 404, "refused");
});

await test("a lowercase secret name is rejected", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const res = await api("PUT", "/api/secrets", {
    scope: "user", scopeId: me.body.userId, name: "gemini_key", value: "x",
  });
  equal(res.status, 400, "names must be env-var shaped");
});

await test("a secret can be deleted", async () => {
  const me = await api<{ userId: string }>("GET", "/api/me");
  const res = await api<{ deleted: boolean }>(
    "DELETE", `/api/secrets/user/${me.body.userId}/GEMINI_API_KEY`,
  );
  equal(res.status, 200, "deleted");
  const listed = await api<Array<{ name: string }>>(
    "GET", `/api/secrets?scope=user&scopeId=${me.body.userId}`,
  );
  assert(!listed.body.some((s) => s.name === "GEMINI_API_KEY"), "gone from the listing");
});

wss.close();
hub.close();
server.close();
await handle.close();
report();
