import { loadEnv } from "@kapi/env";
loadEnv();

import {
  connectDb, createDb, createIsolatedTestSchema, retryDeadlockedTransaction, type DbHandle,
} from "@kapi/db";
import {
  cancelSubtree, claim, complete, enqueue, fail, getJob, heartbeat, listJobs,
  markRunning, reap, startReaper,
} from "@kapi/queue";
import type { Job, JobStatus } from "@kapi/protocol";
import { assert, equal, group, report, sleep, test } from "./harness.ts";
import { seedRun, seedSiblingRun, type Seeded } from "./seed.ts";

const REAL_PG = Boolean(process.env.DATABASE_URL);
if (!REAL_PG) process.env.KAPI_PGLITE_DIR = "memory://queue-test";

const isolated = REAL_PG
  ? await createIsolatedTestSchema(process.env.DATABASE_URL!, "queue")
  : null;
const handle = await createDb(isolated?.url);
console.log(`\n  database: ${handle.target}`);

group("0. startup ownership");

await test("concurrent local bootstraps serialize and production connections only verify", async () => {
  if (handle.embedded) return;
  const bootstraps = await Promise.all(
    Array.from({ length: 8 }, () => createDb(isolated!.url, { bootstrap: true })),
  );
  await Promise.all(bootstraps.map((candidate) => candidate.close()));
  const services = await Promise.all(
    Array.from({ length: 8 }, () => createDb(isolated!.url, { bootstrap: false })),
  );
  await Promise.all(services.map((candidate) => candidate.close()));
});

await test("a production connection fails clearly before pre-deploy migrations", async () => {
  if (handle.embedded) return;
  const blank = await createIsolatedTestSchema(process.env.DATABASE_URL!, "unmigrated");
  try {
    let message = "";
    try { await connectDb(blank.url); }
    catch (err) { message = err instanceof Error ? err.message : String(err); }
    assert(message.includes("pnpm db:migrate"), `actionable migration error, got: ${message}`);
  } finally {
    await blank.cleanup();
  }
});

await test("deadlock retry is bounded and limited to rolled-back 40P01 transactions", async () => {
  let attempts = 0;
  const deadlocking = {
    embedded: false,
    transaction: async (fn: (tx: never) => Promise<number>) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("deadlock"), { code: "40P01" });
      return fn((async () => []) as never);
    },
  } as unknown as DbHandle;
  equal(await retryDeadlockedTransaction(deadlocking, async () => 42), 42, "eventually succeeds");
  equal(attempts, 3, "two retries and no unbounded loop");

  let otherAttempts = 0;
  const otherFailure = {
    embedded: false,
    transaction: async () => {
      otherAttempts++;
      throw Object.assign(new Error("lock unavailable"), { code: "55P03" });
    },
  } as unknown as DbHandle;
  try { await retryDeadlockedTransaction(otherFailure, async () => 0); } catch { /* expected */ }
  equal(otherAttempts, 1, "non-deadlock failures are not retried");
});

const build = (runId: string, over: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  enqueue(handle, {
    runId, kind: "build", role: "backend", instruction: "do the thing",
    acceptance: [], touches: [], dependsOn: [], priority: 0, maxAttempts: 3, context: {},
    ...over,
  });

const okResult = (summary = "done") => ({
  ok: true, summary, filesChanged: [], commits: [],
});

// Stress claims deliberately do not exercise completion. Retire them in one
// statement so later lease tests only reap the rows they created themselves.
const retireStressClaims = async (jobs: Job[]) => {
  if (jobs.length === 0) return;
  await handle.raw(
    `UPDATE jobs SET status='succeeded', lease_expires_at=NULL, finished_at=now()
     WHERE id = ANY($1::text[])`,
    [jobs.map((job) => job.id)],
  );
};

/* ------------------------------------------------------------------ */

group("1. concurrent claim");

await test("N VMs claiming at once produce zero double-claims", async () => {
  if (handle.embedded) {
    throw new Error(
      "This test requires real Postgres and refuses to run on PGlite.\n" +
      "PGlite is single-process, so transactions serialise and FOR UPDATE SKIP\n" +
      "LOCKED is never contended - a green run here would prove nothing.\n\n" +
      "  docker run -d --name kapi-pg -p 5432:5432 -e POSTGRES_PASSWORD=kapi postgres:16\n" +
      "  export DATABASE_URL=postgres://postgres:kapi@localhost:5432/postgres\n" +
      "  pnpm test:unit",
    );
  }

  const s = await seedRun(handle);
  const jobs = await Promise.all(Array.from({ length: 20 }, () => build(s.runId)));

  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, i) => claim(handle, { vmId: `vm-${i}` })),
  );

  const got = claims.filter((c): c is Job => c !== null);
  equal(got.length, 20, "every claimer got a job");
  equal(new Set(got.map((j) => j.id)).size, 20, "no job was claimed twice");
  equal(new Set(got.map((j) => j.vmId)).size, 20, "each job has a distinct lease holder");
  assert(got.every((j) => j.attempts === 1), "attempts incremented exactly once each");
  equal(new Set(jobs.map((j) => j.id)).size, 20, "the enqueued set is what was claimed");
  await retireStressClaims(got);
});

await test("claims spread across runs contend on jobs, not on one run row", async () => {
  if (handle.embedded) throw new Error("requires real Postgres (see above)");

  // Event sequencing takes a per-run lock, so a single run serialises its
  // claims. Four runs prove SKIP LOCKED is doing the work, not that lock.
  const s = await seedRun(handle);
  const runIds = [s.runId, ...(await Promise.all([1, 2, 3].map(() => seedSiblingRun(handle, s))))];
  for (const runId of runIds) {
    await Promise.all(Array.from({ length: 5 }, () => build(runId)));
  }

  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, i) => claim(handle, { vmId: `spread-${i}` })),
  );
  const got = claims.filter((c): c is Job => c !== null);
  equal(got.length, 20, "all 20 jobs claimed");
  equal(new Set(got.map((j) => j.id)).size, 20, "no duplicates across runs");
  await retireStressClaims(got);
});

await test("100 simultaneous claimers across ten runs remain unique", async () => {
  if (handle.embedded) throw new Error("requires real Postgres (see above)");

  const first = await seedRun(handle);
  const runIds = [first.runId, ...(await Promise.all(
    Array.from({ length: 9 }, () => seedSiblingRun(handle, first)),
  ))];
  await Promise.all(runIds.flatMap((runId) =>
    Array.from({ length: 10 }, () => build(runId))));

  const claims = await Promise.all(
    Array.from({ length: 100 }, (_, i) => claim(handle, { vmId: `hundred-${i}` })),
  );
  const got = claims.filter((candidate): candidate is Job => candidate !== null);
  equal(got.length, 100, "every claimer received work");
  equal(new Set(got.map((job) => job.id)).size, 100, "all claimed jobs are unique");
  equal(new Set(got.map((job) => job.vmId)).size, 100, "all leases have unique holders");
  await retireStressClaims(got);
});

await test("more claimers than jobs: the surplus get null, not a duplicate", async () => {
  if (handle.embedded) throw new Error("requires real Postgres (see above)");

  const s = await seedRun(handle);
  await Promise.all(Array.from({ length: 5 }, () => build(s.runId)));

  const claims = await Promise.all(
    Array.from({ length: 15 }, (_, i) => claim(handle, { vmId: `surplus-${i}`, runId: s.runId })),
  );
  const got = claims.filter((c): c is Job => c !== null);
  equal(got.length, 5, "exactly the available jobs were handed out");
  equal(claims.filter((c) => c === null).length, 10, "the rest got nothing");
  equal(new Set(got.map((j) => j.id)).size, 5, "no duplicates");
  await retireStressClaims(got);
});

/* ------------------------------------------------------------------ */

group("2. leases");

await test("an expired lease is requeued and the old VM learns it lost", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId);

  const first = await claim(handle, { vmId: "vm-a", runId: s.runId, leaseSeconds: 1 });
  assert(first?.id === job.id, "vm-a claimed it");
  // Heartbeat with the same short window, or it would extend the very lease
  // this test needs to expire.
  assert(await heartbeat(handle, job.id, "vm-a", 1), "heartbeat works while leased");

  await sleep(1200);
  const reaped = await reap(handle);
  // `reap` is deliberately global. On a remote database the preceding
  // concurrency tests can take long enough for their uncompleted leases to
  // expire too, so the result may legitimately contain more than this job.
  // Assert against the lease this test owns instead of relying on array size
  // or ordering.
  const expired = reaped.find((candidate) => candidate.id === job.id);
  assert(expired, "the reaper found it");
  equal(expired.status, "queued", "requeued rather than failed");
  assert(expired.vmId === null, "lease holder cleared");

  const second = await claim(handle, { vmId: "vm-b", runId: s.runId });
  assert(second?.id === job.id, "a second VM picked it up");
  equal(second!.attempts, 2, "attempts reflects the second claim");

  equal(
    await heartbeat(handle, job.id, "vm-a"),
    false,
    "the evicted VM's heartbeat returns false so it can stop cleanly",
  );
  assert(await heartbeat(handle, job.id, "vm-b"), "the new holder can still heartbeat");
});

await test("a live lease is not reaped", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId);
  await claim(handle, { vmId: "vm-live", runId: s.runId, leaseSeconds: 120 });

  const reaped = await reap(handle);
  assert(!reaped.some((j) => j.id === job.id), "a healthy lease survives the reaper");
});

await test("only the lease holder can complete or fail a job", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId);
  await claim(handle, { vmId: "vm-owner", runId: s.runId });

  equal(await complete(handle, job.id, "vm-impostor", okResult()), null, "wrong VM cannot complete");
  equal(await fail(handle, job.id, "vm-impostor", "nope"), null, "wrong VM cannot fail");
  assert(await complete(handle, job.id, "vm-owner", okResult()), "the holder can");
});

await test("claimed -> running is a real transition", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId);
  await claim(handle, { vmId: "vm-r", runId: s.runId });

  equal((await markRunning(handle, job.id, "vm-r"))?.status, "running", "transitioned");
  equal(await markRunning(handle, job.id, "vm-r"), null, "not repeatable");
  assert(await heartbeat(handle, job.id, "vm-r"), "a running job still heartbeats");
});

/* ------------------------------------------------------------------ */

group("3. dependency gating");

await test("a job waits for its dependency even at higher priority", async () => {
  const s = await seedRun(handle);
  const first = await build(s.runId, { instruction: "schema" });
  const second = await build(s.runId, {
    instruction: "api", dependsOn: [first.id], priority: 100,
  });

  const a = await claim(handle, { vmId: "vm-1", runId: s.runId });
  equal(a?.id, first.id, "priority does not let a blocked job jump the gate");
  equal(await claim(handle, { vmId: "vm-2", runId: s.runId }), null, "nothing else is claimable");

  await complete(handle, first.id, "vm-1", okResult());

  const b = await claim(handle, { vmId: "vm-2", runId: s.runId });
  equal(b?.id, second.id, "the dependant became claimable the moment its dep succeeded");
});

await test("a failed dependency does not release the dependant", async () => {
  const s = await seedRun(handle);
  const dep = await build(s.runId, { maxAttempts: 1 });
  const dependant = await build(s.runId, { dependsOn: [dep.id] });

  await claim(handle, { vmId: "vm-x", runId: s.runId });
  const failed = await fail(handle, dep.id, "vm-x", "exploded");
  equal(failed?.status, "failed", "dependency is terminally failed");

  equal(
    await claim(handle, { vmId: "vm-y", runId: s.runId }),
    null,
    "gating requires SUCCEEDED, not merely terminal",
  );
  const stillQueued = await getJob(handle, dependant.id);
  equal(stillQueued?.status, "queued", "the dependant stays queued for a captain to triage");
});

await test("multiple dependencies all have to succeed", async () => {
  const s = await seedRun(handle);
  const a = await build(s.runId);
  const b = await build(s.runId);
  const c = await build(s.runId, { dependsOn: [a.id, b.id] });

  await claim(handle, { vmId: "v1", runId: s.runId });
  await complete(handle, a.id, "v1", okResult());
  const next = await claim(handle, { vmId: "v2", runId: s.runId });
  equal(next?.id, b.id, "c is still gated by b");

  await complete(handle, b.id, "v2", okResult());
  equal((await claim(handle, { vmId: "v3", runId: s.runId }))?.id, c.id, "now c runs");
});

/* ------------------------------------------------------------------ */

group("4. retry and dead-letter");

await test("failures requeue until maxAttempts, then terminate", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId, { maxAttempts: 3 });

  for (const attempt of [1, 2]) {
    const claimed = await claim(handle, { vmId: `vm-${attempt}`, runId: s.runId });
    equal(claimed?.attempts, attempt, `attempt ${attempt} recorded at claim time`);
    const after = await fail(handle, job.id, `vm-${attempt}`, `boom ${attempt}`);
    equal(after?.status, "queued", `requeued after attempt ${attempt}`);
    equal(after?.vmId, null, "lease released on requeue");
  }

  await claim(handle, { vmId: "vm-3", runId: s.runId });
  const dead = await fail(handle, job.id, "vm-3", "boom 3");
  equal(dead?.status, "failed", "dead-lettered on the last attempt");
  equal(dead?.error, "boom 3", "the last error is retained");
  assert(dead?.finishedAt instanceof Date, "finishedAt is set");
  equal(dead?.vmId, "vm-3", "the VM that died is retained for forensics");

  equal(await claim(handle, { vmId: "vm-4", runId: s.runId }), null, "a dead job is not reclaimable");
});

await test("the reaper honours maxAttempts too", async () => {
  const s = await seedRun(handle);
  const job = await build(s.runId, { maxAttempts: 1 });

  await claim(handle, { vmId: "vm-gone", runId: s.runId, leaseSeconds: 1 });
  await sleep(1200);

  const reaped = await reap(handle);
  equal(reaped.find((j) => j.id === job.id)?.status, "failed", "no attempts left, so terminal");
});

await test("one reap distinguishes a requeued job from a dead-lettered one", async () => {
  // The control plane reads exactly this to decide whether a run is over: a
  // dead-lettered root ends its run, a requeued one must not. Both come back in
  // the same batch, told apart only by their new status.
  const s = await seedRun(handle);
  const doomed = await build(s.runId, { maxAttempts: 1 });
  const survivor = await build(s.runId, { maxAttempts: 3 });

  await claim(handle, { vmId: "vm-1", runId: s.runId, jobId: doomed.id, leaseSeconds: 1 });
  await claim(handle, { vmId: "vm-2", runId: s.runId, jobId: survivor.id, leaseSeconds: 1 });
  await sleep(1200);

  const reaped = await reap(handle);
  equal(reaped.find((j) => j.id === doomed.id)?.status, "failed", "out of attempts, terminal");
  equal(reaped.find((j) => j.id === survivor.id)?.status, "queued", "attempts left, requeued");
});

await test("startReaper awaits an async hook and survives one that throws", async () => {
  const s = await seedRun(handle);
  const first = await build(s.runId, { maxAttempts: 1 });
  const second = await build(s.runId, { maxAttempts: 1 });

  await claim(handle, { vmId: "vm-hook-1", runId: s.runId, jobId: first.id, leaseSeconds: 1 });
  await sleep(1200);

  // Note a batch is consumed by the reap that produced it: a hook that throws
  // does not get those jobs offered again. What must survive is the reaper.
  let threw = false;
  let asyncBodyFinished = false;
  const stop = startReaper(handle, {
    // Slow enough that ticks do not pile up on a remote database: setInterval
    // does not wait for an async tick, and overlapping reap transactions
    // contend on the same rows and starve each other.
    intervalMs: 250,
    onReap: async (jobs) => {
      if (jobs.some((j) => j.id === first.id)) {
        threw = true;
        throw new Error("a hook that blows up on the batch it was given");
      }
      if (jobs.some((j) => j.id === second.id)) {
        // Awaited by the reaper, so this completes before the next tick can
        // start. Unawaited, a slow hook and the tick after it race the same run.
        await sleep(60);
        asyncBodyFinished = true;
      }
    },
  });

  // Generous windows: normally a tick or two, but this suite runs against real
  // Postgres and a slow link must read as slow, not as broken.
  const until = async (done: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await sleep(100);
  };

  await until(() => threw);
  assert(threw, "the hook was handed the reaped batch");

  // A second expiry, after the throw. If a throwing hook killed the loop this
  // one would never be seen at all.
  await claim(handle, { vmId: "vm-hook-2", runId: s.runId, jobId: second.id, leaseSeconds: 1 });
  await sleep(1200);
  await until(() => asyncBodyFinished);
  stop();

  assert(asyncBodyFinished, "a later batch's async hook ran to completion");
});

/* ------------------------------------------------------------------ */

group("5. cancel subtree");

await test("cancelling a captain cancels its descendants and nothing else", async () => {
  const s = await seedRun(handle);
  const captain = await enqueue(handle, {
    runId: s.runId, kind: "captain", role: "captain", instruction: "lead",
    acceptance: [], touches: [], dependsOn: [], priority: 0, maxAttempts: 3, context: {},
  });
  const child = await build(s.runId, { parentJobId: captain.id });
  const grandchild = await build(s.runId, { parentJobId: child.id });
  const done = await build(s.runId, { parentJobId: child.id });
  const unrelated = await build(s.runId);

  // A leased descendant must be cancellable too, not just a queued one.
  await claim(handle, { vmId: "vm-c", runId: s.runId, jobId: child.id });
  await claim(handle, { vmId: "vm-d", runId: s.runId, jobId: done.id });
  await complete(handle, done.id, "vm-d", okResult("already landed"));

  const cancelled = await cancelSubtree(handle, captain.id, "captain abandoned this line");
  const ids = new Set(cancelled.map((j) => j.id));

  assert(ids.has(captain.id), "the captain itself");
  assert(ids.has(child.id), "a claimed child is cancelled");
  assert(ids.has(grandchild.id), "cancellation is recursive");
  assert(!ids.has(done.id), "a succeeded descendant is left alone");
  assert(!ids.has(unrelated.id), "an unrelated job is untouched");

  equal((await getJob(handle, done.id))?.status, "succeeded", "succeeded work is preserved");
  equal((await getJob(handle, unrelated.id))?.status, "queued", "the sibling is still claimable");
  equal((await getJob(handle, grandchild.id))?.error, "captain abandoned this line", "reason recorded");
});

/* ------------------------------------------------------------------ */

group("6. event stream agrees with job state");

await test("replaying events reproduces every job's final status", async () => {
  const s = await seedRun(handle);
  const a = await build(s.runId);
  const b = await build(s.runId, { maxAttempts: 1 });
  const c = await build(s.runId);
  const d = await build(s.runId, { parentJobId: c.id });

  await claim(handle, { vmId: "e1", runId: s.runId, jobId: a.id });
  await markRunning(handle, a.id, "e1");
  await complete(handle, a.id, "e1", okResult());

  await claim(handle, { vmId: "e2", runId: s.runId, jobId: b.id });
  await fail(handle, b.id, "e2", "nope");

  await cancelSubtree(handle, c.id);

  const rows = await handle.raw<{ seq: number; job_id: string | null; kind: string; payload: { status?: JobStatus } }>(
    `SELECT seq, job_id, kind, payload FROM events WHERE run_id = $1 ORDER BY seq ASC`,
    [s.runId],
  );

  const seqs = rows.map((r) => Number(r.seq));
  equal(seqs[0], 1, "sequence starts at 1");
  assert(seqs.every((n, i) => n === i + 1), `sequence is gap-free and ordered: ${seqs.join(",")}`);

  const replayed = new Map<string, JobStatus>();
  for (const row of rows) {
    if (row.kind === "job.status" && row.job_id && row.payload.status) {
      replayed.set(row.job_id, row.payload.status);
    }
  }

  for (const job of await listJobs(handle, s.runId)) {
    equal(replayed.get(job.id), job.status, `replayed status for ${job.id} (${job.payload.instruction})`);
  }
  equal(replayed.size, 4, "every job appears in the stream");
  equal(replayed.get(d.id), "cancelled", "the grandchild was cancelled through the tree");
});

await test("enqueue counts against the run's spawn total", async () => {
  const s = await seedRun(handle);
  await Promise.all(Array.from({ length: 7 }, () => build(s.runId)));
  const rows = await handle.raw<{ total_spawns: number }>(
    `SELECT total_spawns FROM runs WHERE id = $1`, [s.runId],
  );
  equal(Number(rows[0]!.total_spawns), 7, "total_spawns tracks every spawn");
});

await test("appending an event for an unknown run is refused", async () => {
  let threw = false;
  try {
    await enqueue(handle, {
      runId: "run_does_not_exist", kind: "build", role: "backend", instruction: "x",
      acceptance: [], touches: [], dependsOn: [], priority: 0, maxAttempts: 3, context: {},
    });
  } catch {
    threw = true;
  }
  assert(threw, "a job cannot exist without its run");
});

await handle.close();
await isolated?.cleanup();
report();
