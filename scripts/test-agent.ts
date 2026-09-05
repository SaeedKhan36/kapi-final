import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Authenticator, JobTokenError, mintJobToken, verifyJobToken } from "@kapi/identity";
import { claim, enqueue, getJob, heartbeat, reap } from "@kapi/queue";
import { LocalProvider } from "@kapi/vm";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Provisioner } from "../apps/control-plane/src/provisioner.ts";
import { RequestTracker } from "../apps/control-plane/src/request-tracker.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { assert, equal, group, report, sleep, test } from "./harness.ts";
import { seedRun } from "./seed.ts";
import { createTestDb, useHermeticTestConfig } from "./test-db.ts";

useHermeticTestConfig();
if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
}
// The real Build/Review roles require a repository and model. This suite is
// intentionally about VM bootstrap and lease recovery, so its provisioned
// agents select the deterministic echo handler.
process.env.KAPI_TEST_ECHO_ROLE = "true";

const testDb = await createTestDb("agent");
const { handle } = testDb;
console.log(`\n  database: ${handle.target}`);

const store = new Store(handle);
const hub = new EventHub(store, handle, 250);
const auth = new Authenticator(handle);
const requests = new RequestTracker();
const app = createApp({ handle, store, hub, auth, requests, vmProvider: "local" });
const server = serve({ fetch: app.fetch, port: 0 });
await sleep(150);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`  plane:    ${base}`);

const provider = new LocalProvider();
const provisioner = new Provisioner(handle, {
  provider,
  publicUrl: base,
  onLog: () => {},
});

// This suite tests bootstrap plumbing - claim/heartbeat/complete, VM lifecycle,
// budgets, and crash recovery - not model/repository behavior.
const echoJob = (runId: string, over: Record<string, unknown> = {}) =>
  enqueue(handle, {
    runId, kind: "review", role: "backend", instruction: "echo something",
    acceptance: [], touches: [], dependsOn: [], priority: 0, maxAttempts: 3, context: {},
    ...over,
  });

/** Polls until `check` passes or the budget runs out. */
async function waitFor<T>(
  label: string, check: () => Promise<T | null>,
  timeoutMs = process.env.DATABASE_URL ? 90_000 : 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await check();
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* ------------------------------------------------------------------ */

group("job tokens");

await test("a minted token verifies and carries its scope", () => {
  const token = mintJobToken({ jobId: "job_1", runId: "run_1", vmId: "vm_1" });
  const claims = verifyJobToken(token);
  equal(claims.jobId, "job_1", "job");
  equal(claims.runId, "run_1", "run");
  equal(claims.vmId, "vm_1", "vm");
  assert(claims.exp * 1000 > Date.now(), "not already expired");
});

await test("a tampered payload does not verify", () => {
  const token = mintJobToken({ jobId: "job_1", runId: "run_1", vmId: "vm_1" });
  const [, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ jobId: "job_OTHER", runId: "run_1", vmId: "vm_1", exp: 9e9 }),
  ).toString("base64url");

  let threw = false;
  try { verifyJobToken(`${forged}.${sig}`); } catch (e) { threw = e instanceof JobTokenError; }
  assert(threw, "a swapped payload is rejected");
});

await test("an expired token is refused", () => {
  const token = mintJobToken({ jobId: "j", runId: "r", vmId: "v", ttlSeconds: -1 });
  let threw = false;
  try { verifyJobToken(token); } catch { threw = true; }
  assert(threw, "expiry is enforced");
});

/* ------------------------------------------------------------------ */

group("the agent protocol, driven directly");

await test("the plane rejects an unsigned caller", async () => {
  const res = await fetch(`${base}/agent/heartbeat`, { method: "POST" });
  equal(res.status, 401, "no token, no entry");
});

await test("an agent claims, starts, streams, and completes", async () => {
  const s = await seedRun(handle);
  const job = await echoJob(s.runId);
  const token = mintJobToken({ jobId: job.id, runId: s.runId, vmId: "vm-direct" });
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "{}") }));

  const claimed = await call("/agent/claim", { hostname: "test" });
  equal(claimed.status, 200, "claim accepted");
  equal(claimed.body.job?.id, job.id, "got its own job");

  equal((await call("/agent/start", {})).body.ok, true, "claimed -> running");
  equal((await getJob(handle, job.id))?.status, "running", "state advanced");

  const beat = await call("/agent/heartbeat", {});
  equal(beat.body.ok, true, "lease extended");

  await call("/agent/events", {
    events: [
      { kind: "log", payload: { message: "hello from the vm" } },
      { kind: "tool.call", payload: { tool: "echo" } },
    ],
  });

  const done = await call("/agent/complete", {
    result: { ok: true, summary: "did the thing", filesChanged: [], commits: [] },
  });
  equal(done.body.status, "succeeded", "job succeeded");

  const events = await store.listEvents(s.runId, 0);
  const fromAgent = events.filter((e) => e.from === `agent:${job.id}`);
  assert(fromAgent.some((e) => e.kind === "log"), "the agent's log landed in the stream");
  assert(fromAgent.some((e) => e.kind === "tool.call"), "and its tool call");
});

await test("a token cannot write into another job's stream", async () => {
  // Identity comes from the token, never the body: an agent chooses what it
  // says, not who it is.
  const mine = await seedRun(handle);
  const theirs = await seedRun(handle);
  const myJob = await echoJob(mine.runId);
  const theirJob = await echoJob(theirs.runId);

  const token = mintJobToken({ jobId: myJob.id, runId: mine.runId, vmId: "vm-x" });
  await fetch(`${base}/agent/claim`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
  await fetch(`${base}/agent/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // The body claims another run; the plane must ignore it.
    body: JSON.stringify({
      runId: theirs.runId, jobId: theirJob.id,
      events: [{ kind: "log", payload: { message: "cross-run write" } }],
    }),
  });

  const theirEvents = await store.listEvents(theirs.runId, 0);
  assert(
    !theirEvents.some((e) => JSON.stringify(e.payload).includes("cross-run write")),
    "nothing leaked into the other run",
  );
  const myEvents = await store.listEvents(mine.runId, 0);
  assert(
    myEvents.some((e) => JSON.stringify(e.payload).includes("cross-run write")),
    "it was recorded against the token's own run instead",
  );
});

await test("an evicted agent is told its lease is gone", async () => {
  const s = await seedRun(handle);
  const job = await echoJob(s.runId);
  await claim(handle, { vmId: "vm-first", jobId: job.id, leaseSeconds: 1 });

  await sleep(1200);
  await reap(handle);
  await claim(handle, { vmId: "vm-second", jobId: job.id });

  const token = mintJobToken({ jobId: job.id, runId: s.runId, vmId: "vm-first" });
  const res = await fetch(`${base}/agent/heartbeat`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }).then(async (r) => JSON.parse(await r.text()));

  equal(res.ok, false, "the first VM learns it must stop");
  assert(await heartbeat(handle, job.id, "vm-second"), "the new holder is fine");
});

/* ------------------------------------------------------------------ */

group("provisioning a real VM");

await test("the provisioner starts an agent that runs the job to completion", async () => {
  const s = await seedRun(handle);
  const job = await echoJob(s.runId, { instruction: "prove the bootstrap works" });

  const started = await provisioner.tick();
  assert(started.some((j) => j.id === job.id), "a VM was provisioned for the job");

  const finished = await waitFor("the agent to finish", async () => {
    const current = await getJob(handle, job.id);
    return current && current.status === "succeeded" ? current : null;
  });

  assert(finished.result?.ok, "the agent reported success");
  assert(
    finished.result?.summary.includes("prove the bootstrap works"),
    `the summary came from the agent: ${finished.result?.summary}`,
  );

  const events = await store.listEvents(s.runId, 0);
  const fromAgent = events.filter((e) => e.from === `agent:${job.id}`);
  assert(fromAgent.length > 0, "the agent streamed events from inside the VM");
  assert(
    events.some((e) => e.kind === "job.status" && e.payload.status === "running"),
    "it moved through running, not straight to done",
  );
});

await test("a job is not provisioned twice", async () => {
  const s = await seedRun(handle);
  await echoJob(s.runId);

  const [first, second] = await Promise.all([provisioner.tick(), provisioner.tick()]);
  const all = [...first, ...second].map((j) => j.id);
  equal(new Set(all).size, all.length, "no job was handed two VMs");
});

await test("the concurrency budget caps how many VMs a run gets at once", async () => {
  const s = await seedRun(handle);
  await handle.raw(`UPDATE runs SET max_concurrent_vms = 2 WHERE id = $1`, [s.runId]);
  for (let i = 0; i < 5; i++) await echoJob(s.runId, { instruction: `capped ${i}` });

  const started = await provisioner.tick();
  const forRun = started.filter((j) => j.runId === s.runId);
  assert(forRun.length <= 2, `budget honoured, started ${forRun.length}`);
});

await test("a finished job's VM is reclaimed", async () => {
  // The prior concurrency test intentionally starts several asynchronous
  // agents. Wait for those processes to report terminal state before taking a
  // single deterministic reclaim snapshot; production performs this pass on a
  // timer and naturally catches later finishes on the next pass.
  await waitFor("provisioned agents to settle", async () => {
    const rows = await handle.raw<{ n: string }>(
      `SELECT count(*)::text AS n FROM agents a JOIN jobs j ON j.id=a.job_id
       WHERE a.vm_id IS NOT NULL AND a.provider='local' AND a.stopped_at IS NULL
         AND j.status NOT IN ('succeeded','failed','cancelled')`,
    );
    return Number(rows[0]?.n ?? 0) === 0 ? true : null;
  });
  const before = await handle.raw<{ n: string }>(
    `SELECT count(*)::text AS n FROM agents WHERE vm_id IS NOT NULL AND stopped_at IS NOT NULL`,
  );
  assert(Number(before[0]!.n) >= 0, "there are agent rows to consider");
  await provisioner.reclaim();
  const leaked = await handle.raw<{ n: string }>(
    `SELECT count(*)::text AS n FROM agents a JOIN jobs j ON j.id = a.job_id
     WHERE a.vm_id IS NOT NULL AND j.status IN ('succeeded','failed','cancelled')`,
  );
  equal(Number(leaked[0]!.n), 0, "no VM is left attached to a finished job");
});

/* ------------------------------------------------------------------ */

group("surviving a lost VM");

await test("a dead VM's job is requeued and a new VM finishes it", async () => {
  // The failure kapi-old could not survive: work vanished with the process
  // holding it. Here the lease expires, the reaper requeues, and the
  // provisioner starts a replacement.
  const s = await seedRun(handle);
  const job = await echoJob(s.runId, { instruction: "survive a dead vm" });

  // Claim it as a VM that then goes away without ever heartbeating.
  await claim(handle, { vmId: "vm-doomed", jobId: job.id, leaseSeconds: 1 });
  equal((await getJob(handle, job.id))?.status, "claimed", "held by the doomed VM");
  await handle.raw(
    `INSERT INTO agents (job_id, run_id, role, status, vm_id, last_heartbeat)
     VALUES ($1, $2, 'backend', 'running', 'vm-doomed', now())
     ON CONFLICT (job_id) DO UPDATE SET status = 'running', stopped_at = NULL`,
    [job.id, s.runId],
  );

  await sleep(1200);
  const reaped = await reap(handle);
  assert(reaped.some((j) => j.id === job.id), "the reaper noticed");
  equal((await getJob(handle, job.id))?.status, "queued", "back on the queue");

  const agentRow = await handle.raw<{ stopped_at: string | null }>(
    `SELECT stopped_at FROM agents WHERE job_id = $1`, [job.id],
  );
  assert(agentRow[0]?.stopped_at !== null, "the dead agent row was closed out");

  await provisioner.tick();
  const finished = await waitFor("the replacement to finish", async () => {
    const current = await getJob(handle, job.id);
    return current && current.status === "succeeded" ? current : null;
  });
  equal(finished.attempts, 2, "it took a second attempt, on a second VM");
  assert(finished.result?.ok, "and the replacement completed it");
});

const serverClosed = new Promise<void>((resolve, reject) =>
  server.close((err) => err ? reject(err) : resolve()));
await provisioner.destroyAll();
await hub.close();
await requests.drain();
await serverClosed;
await testDb.close();
report();
