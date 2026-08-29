import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, truncateAll } from "@kapi/db";
import { Authenticator, mintJobToken } from "@kapi/identity";
import type {
  AgentChildrenResponse, AgentInboxMessage, AgentSpawnResponse,
  ModelResponse, SpawnRequest, WireMessage,
} from "@kapi/protocol";
import {
  CAPTAIN_TOOLS, cancelAgentTool, checkAgentsTool, replyToAgentTool,
  runLoop, spawnAgentsTool, waitForAgentsTool,
  type FleetOps, type ToolContext,
} from "@kapi/agent-core";
import { claim, complete, enqueue, fail, getJob, listJobs } from "@kapi/queue";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Store } from "../apps/control-plane/src/store.ts";
import { assert, equal, group, report, test } from "./harness.ts";
import { seedRun } from "./seed.ts";

if (!process.env.DATABASE_URL) process.env.KAPI_PGLITE_DIR = "memory://captain-test";
if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 11).toString("base64");
}

const handle = await createDb();
console.log(`\n  database: ${handle.target}`);
await truncateAll(handle);

const store = new Store(handle);
const hub = new EventHub(store, handle, 250);
const auth = new Authenticator(handle);
const app = createApp({ handle, store, hub, auth, vmProvider: "local" });
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise((r) => setTimeout(r, 150));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`  plane:    ${base}\n`);

/** A captain job on a fresh run, plus a fleet wired to the real plane. */
async function captainOnRun(budgets: Partial<{
  maxTotalSpawns: number; maxSpawnDepth: number;
}> = {}) {
  const seeded = await seedRun(handle);
  if (budgets.maxTotalSpawns !== undefined) {
    await handle.raw(`UPDATE runs SET max_total_spawns = $2 WHERE id = $1`,
      [seeded.runId, budgets.maxTotalSpawns]);
  }
  if (budgets.maxSpawnDepth !== undefined) {
    await handle.raw(`UPDATE runs SET max_spawn_depth = $2 WHERE id = $1`,
      [seeded.runId, budgets.maxSpawnDepth]);
  }

  const job = await enqueue(handle, {
    runId: seeded.runId, parentJobId: null, kind: "captain", role: "captain",
    instruction: "lead the work", acceptance: [], touches: [], dependsOn: [],
    priority: 10, maxAttempts: 1, context: {},
  });
  const vmId = `vm-${job.id}`;
  await claim(handle, { vmId, jobId: job.id, runId: seeded.runId });
  const token = mintJobToken({ jobId: job.id, runId: seeded.runId, vmId });

  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return JSON.parse((await res.text()) || "{}") as T;
  };

  let inboxCursor = 0;
  const fleet: FleetOps = {
    spawn: (agents: SpawnRequest[]) => call<AgentSpawnResponse>("POST", "/agent/spawn", { agents }),
    children: () => call<AgentChildrenResponse>("GET", "/agent/children"),
    cancelChild: async (childId, reason) =>
      (await call<{ cancelled: string[] }>("POST", "/agent/cancel-child", { jobId: childId, reason })).cancelled,
    sendTo: async (address, content) => {
      await call("POST", "/agent/events", {
        events: [{ kind: "agent.message", to: address, payload: { content } }],
      });
    },
    pollInbox: async () => {
      const res = await call<{ messages: AgentInboxMessage[]; cursor: number }>(
        "GET", `/agent/inbox?after=${inboxCursor}`,
      );
      inboxCursor = res.cursor;
      return res.messages;
    },
  };

  const cwd = await mkdtemp(join(tmpdir(), "kapi-captain-"));
  let alive = true;
  const ctx: ToolContext = {
    cwd, jobId: job.id, runId: seeded.runId,
    log: () => {},
    gitCredentials: async () => { throw new Error("no credential in this test"); },
    askCaptain: async () => null,
    fleet,
    alive: () => alive,
  };

  /**
   * A tool context for one of this captain's descendants, so a test can drive
   * a sub-captain the same way the real agent binary would.
   */
  const contextFor = async (childJobId: string): Promise<ToolContext> => {
    const childVm = `vm-${childJobId}`;
    await claim(handle, { vmId: childVm, jobId: childJobId, runId: seeded.runId });
    const childToken = mintJobToken({
      jobId: childJobId, runId: seeded.runId, vmId: childVm,
    });
    const childCall = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${childToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return JSON.parse((await res.text()) || "{}") as T;
    };
    let childCursor = 0;
    const childDir = await mkdtemp(join(tmpdir(), "kapi-sub-"));
    return {
      cwd: childDir, jobId: childJobId, runId: seeded.runId,
      log: () => {},
      gitCredentials: async () => { throw new Error("no credential in this test"); },
      askCaptain: async () => null,
      alive: () => true,
      fleet: {
        spawn: (agents: SpawnRequest[]) =>
          childCall<AgentSpawnResponse>("POST", "/agent/spawn", { agents }),
        children: () => childCall<AgentChildrenResponse>("GET", "/agent/children"),
        cancelChild: async (id, reason) =>
          (await childCall<{ cancelled: string[] }>(
            "POST", "/agent/cancel-child", { jobId: id, reason })).cancelled,
        sendTo: async (address, content) => {
          await childCall("POST", "/agent/events", {
            events: [{ kind: "agent.message", to: address, payload: { content } }],
          });
        },
        pollInbox: async () => {
          const res = await childCall<{ messages: AgentInboxMessage[]; cursor: number }>(
            "GET", `/agent/inbox?after=${childCursor}`,
          );
          childCursor = res.cursor;
          return res.messages;
        },
      },
    };
  };

  return {
    seeded, job, ctx, fleet, token, call, contextFor,
    kill: () => { alive = false; },
  };
}

/** A spawn request with the fields the schema needs. */
const want = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  kind: "build", role: "backend", instruction: "do a thing",
  acceptance: [], touches: [], dependsOn: [], priority: 0, context: {}, ...over,
});

/* ------------------------------------------------------------------ */

group("spawning");

await test("spawn_agents creates real child jobs under the captain", async () => {
  const cap = await captainOnRun();
  const res = await spawnAgentsTool.run({
    agents: [
      { role: "backend", instruction: "add the endpoint", touches: ["src/api.ts"] },
      { role: "frontend", instruction: "add the page", touches: ["src/page.tsx"] },
    ],
  }, cap.ctx);

  assert(res.ok !== false, `spawned: ${res.output}`);
  const jobs = await listJobs(handle, cap.seeded.runId);
  const children = jobs.filter((j) => j.parentJobId === cap.job.id);
  equal(children.length, 2, "two children exist");
  assert(children.every((c) => c.status === "queued"), "queued for a VM to claim");
  assert(
    children.some((c) => c.payload.touches.includes("src/api.ts")),
    "file ownership carried through, which is how the captain keeps workers apart",
  );

  const events = await store.listEvents(cap.seeded.runId, 0);
  equal(
    events.filter((e) => e.kind === "agent.spawned").length, 2,
    "both spawns are on the stream",
  );
});

await test("a captain may spawn another captain", async () => {
  const cap = await captainOnRun({ maxSpawnDepth: 3 });
  const res = await spawnAgentsTool.run({
    agents: [{ kind: "captain", role: "captain", instruction: "own the whole frontend" }],
  }, cap.ctx);
  assert(res.ok !== false, "sub-captain allowed within the depth budget");
  const jobs = await listJobs(handle, cap.seeded.runId);
  assert(jobs.some((j) => j.kind === "captain" && j.parentJobId === cap.job.id), "it exists");
});

await test("spawning without a fleet is refused rather than crashing", async () => {
  const cap = await captainOnRun();
  const res = await spawnAgentsTool.run(
    { agents: [want()] },
    { ...cap.ctx, fleet: undefined },
  );
  equal(res.ok, false, "refused");
});

/* ------------------------------------------------------------------ */

group("budgets are facts, not errors");

await test("the total spawn budget refuses further agents and says why", async () => {
  // The run's own captain job counts as a spawn, so a budget of 3 leaves 2.
  const cap = await captainOnRun({ maxTotalSpawns: 3 });
  const res = await spawnAgentsTool.run({
    agents: [
      { role: "backend", instruction: "one" },
      { role: "frontend", instruction: "two" },
      { role: "testing", instruction: "three" },
      { role: "docs", instruction: "four" },
    ],
  }, cap.ctx);

  const spawned = await listJobs(handle, cap.seeded.runId)
    .then((jobs) => jobs.filter((j) => j.parentJobId === cap.job.id));

  assert(spawned.length >= 1, "it spawned what it could");
  assert(spawned.length < 4, `and not all four, got ${spawned.length}`);
  assert(res.output.includes("budget"), `the refusal names the budget: ${res.output}`);
  // The whole design point: a refusal is a tool result to reason about, not an
  // exception that kills the run.
  assert(res.ok !== false, "a partial refusal is still a usable result");
});

await test("the depth budget stops delegation from nesting forever", async () => {
  // maxSpawnDepth counts levels below the root captain, so 1 permits its own
  // children and refuses theirs. The refusal has to land on the sub-captain,
  // which is the only place the recursion is actually tested.
  const cap = await captainOnRun({ maxSpawnDepth: 1, maxTotalSpawns: 20 });

  const first = await spawnAgentsTool.run({
    agents: [{ kind: "captain", role: "captain", instruction: "own a sub-area" }],
  }, cap.ctx);
  assert(first.ok !== false, `depth 1 is allowed: ${first.output}`);

  const sub = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.parentJobId === cap.job.id)!;
  const subCtx = await cap.contextFor(sub.id);

  const second = await spawnAgentsTool.run({
    agents: [{ role: "backend", instruction: "one level too deep" }],
  }, subCtx);

  assert(second.output.toLowerCase().includes("depth"), `explains the limit: ${second.output}`);
  const grandchildren = (await listJobs(handle, cap.seeded.runId))
    .filter((j) => j.parentJobId === sub.id);
  equal(grandchildren.length, 0, "nothing was created past the depth limit");
});

/* ------------------------------------------------------------------ */

group("monitoring");

await test("check_agents reports real child status", async () => {
  const cap = await captainOnRun();
  await spawnAgentsTool.run({
    agents: [{ role: "backend", instruction: "will succeed" },
             { role: "frontend", instruction: "will fail" }],
  }, cap.ctx);

  const [a, b] = (await listJobs(handle, cap.seeded.runId))
    .filter((j) => j.parentJobId === cap.job.id);

  await claim(handle, { vmId: "w1", jobId: a!.id });
  await complete(handle, a!.id, "w1", {
    ok: true, summary: "endpoint added", filesChanged: [], commits: ["abc1234"],
    branch: "kapi/child-a",
  });
  await claim(handle, { vmId: "w2", jobId: b!.id });
  await fail(handle, b!.id, "w2", "the build broke");

  const res = await checkAgentsTool.run({}, cap.ctx);
  assert(res.output.includes("endpoint added"), "shows what succeeded");
  assert(res.output.includes("succeeded"), "and its status");
  assert(
    res.output.includes("the build broke") || res.output.includes("fail"),
    `and the failure: ${res.output}`,
  );
});

await test("wait_for_agents returns once its agents are terminal", async () => {
  const cap = await captainOnRun();
  await spawnAgentsTool.run({ agents: [{ role: "backend", instruction: "quick" }] }, cap.ctx);
  const child = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.parentJobId === cap.job.id)!;

  await claim(handle, { vmId: "w", jobId: child.id });
  await complete(handle, child.id, "w", {
    ok: true, summary: "done quickly", filesChanged: [], commits: [],
  });

  const res = await waitForAgentsTool.run({ timeout_seconds: 30 }, cap.ctx);
  assert(res.output.includes("done quickly"), "returned the result");
  equal(res.meta?.done, 1, "counted it as finished");
});

await test("wait_for_agents comes back early when a worker asks a question", async () => {
  // A question answered late is a worker that already guessed.
  const cap = await captainOnRun();
  await spawnAgentsTool.run({ agents: [{ role: "backend", instruction: "will ask" }] }, cap.ctx);
  const child = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.parentJobId === cap.job.id)!;

  const childVm = "w-asking";
  await claim(handle, { vmId: childVm, jobId: child.id });
  const childToken = mintJobToken({ jobId: child.id, runId: cap.seeded.runId, vmId: childVm });
  await fetch(`${base}/agent/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${childToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        kind: "agent.message", to: `agent:${cap.job.id}`,
        payload: { content: "Should I use snake_case or camelCase?", question: true },
      }],
    }),
  });

  const started = Date.now();
  const res = await waitForAgentsTool.run({ timeout_seconds: 60 }, cap.ctx);
  assert(Date.now() - started < 30_000, "did not sit on the full timeout");
  assert(res.output.includes("snake_case"), `handed the question back: ${res.output}`);
  assert(res.output.includes("reply_to_agent"), "and told the captain how to answer");
});

await test("a lost lease stops wait_for_agents between polls", async () => {
  const cap = await captainOnRun();
  await spawnAgentsTool.run({ agents: [{ role: "backend", instruction: "never finishes" }] }, cap.ctx);
  cap.kill();
  const res = await waitForAgentsTool.run({ timeout_seconds: 60 }, cap.ctx);
  assert(res.output.includes("no longer live"), `stopped promptly: ${res.output}`);
});

/* ------------------------------------------------------------------ */

group("steering and triage");

await test("reply_to_agent reaches the worker that asked", async () => {
  const cap = await captainOnRun();
  await spawnAgentsTool.run({ agents: [{ role: "backend", instruction: "waiting" }] }, cap.ctx);
  const child = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.parentJobId === cap.job.id)!;

  const res = await replyToAgentTool.run(
    { job_id: child.id, answer: "Use camelCase." }, cap.ctx,
  );
  assert(res.ok !== false, `sent: ${res.output}`);

  const childVm = "w-listening";
  await claim(handle, { vmId: childVm, jobId: child.id });
  const childToken = mintJobToken({ jobId: child.id, runId: cap.seeded.runId, vmId: childVm });
  const inbox = await fetch(`${base}/agent/inbox?after=0`, {
    headers: { authorization: `Bearer ${childToken}` },
  }).then(async (r) => JSON.parse(await r.text()) as { messages: AgentInboxMessage[] });

  assert(
    inbox.messages.some((m) => m.content.includes("camelCase")),
    `the worker can read it: ${JSON.stringify(inbox.messages)}`,
  );
});

await test("cancel_agent cancels a child and everything under it", async () => {
  const cap = await captainOnRun({ maxSpawnDepth: 4 });
  await spawnAgentsTool.run({
    agents: [{ kind: "captain", role: "captain", instruction: "a doomed sub-area" }],
  }, cap.ctx);
  const sub = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.parentJobId === cap.job.id)!;

  // Give the sub-captain a child of its own, so the cancel has to recurse.
  const grandchild = await enqueue(handle, {
    runId: cap.seeded.runId, parentJobId: sub.id, kind: "build", role: "backend",
    instruction: "work nobody will need", acceptance: [], touches: [], dependsOn: [],
    priority: 0, maxAttempts: 1, context: {},
  });

  const res = await cancelAgentTool.run(
    { job_id: sub.id, reason: "the approach changed" }, cap.ctx,
  );
  assert(res.ok !== false, `cancelled: ${res.output}`);
  equal((await getJob(handle, sub.id))?.status, "cancelled", "the sub-captain");
  equal((await getJob(handle, grandchild.id))?.status, "cancelled", "and its child");
});

await test("a captain cannot cancel an agent that is not its own", async () => {
  const mine = await captainOnRun();
  const theirs = await captainOnRun();
  await spawnAgentsTool.run({ agents: [{ role: "backend", instruction: "theirs" }] }, theirs.ctx);
  const notMine = (await listJobs(handle, theirs.seeded.runId))
    .find((j) => j.parentJobId === theirs.job.id)!;

  const res = await cancelAgentTool.run({ job_id: notMine.id }, mine.ctx);
  equal(res.ok, false, "refused");
  assert((await getJob(handle, notMine.id))?.status !== "cancelled", "and it still runs");
});

/* ------------------------------------------------------------------ */

group("the captain adapts to what comes back");

await test("the captain spawns AGAIN after seeing a result", async () => {
  /*
   * The assertion this whole rebuild turns on.
   *
   * kapi-old planned every task before any worker started, so the work could
   * never respond to what was learned. Here the second spawn must happen
   * strictly after the first child reported - proven from the event stream's
   * sequence numbers, not from the model's narration.
   */
  const cap = await captainOnRun({ maxTotalSpawns: 20 });

  const script: Array<{ tool: string; input: Record<string, unknown> }> = [
    { tool: "spawn_agents", input: {
        agents: [{ role: "backend", instruction: "investigate the schema" }] } },
    { tool: "wait_for_agents", input: { timeout_seconds: 30 } },
    // Chosen only after the first agent's summary comes back.
    { tool: "spawn_agents", input: {
        agents: [{ role: "frontend", instruction: "follow-on decided from the finding" }] } },
    { tool: "finish", input: { summary: "adapted to the finding" } },
  ];

  let i = 0;
  const callModel = async (req: { messages: WireMessage[] }): Promise<ModelResponse> => {
    // Between the wait and the follow-on spawn, finish the child so the wait
    // resolves and its summary is in the transcript.
    if (i === 1) {
      const child = (await listJobs(handle, cap.seeded.runId))
        .find((j) => j.parentJobId === cap.job.id)!;
      await claim(handle, { vmId: "inv", jobId: child.id });
      await complete(handle, child.id, "inv", {
        ok: true, summary: "the schema uses snake_case throughout",
        filesChanged: [], commits: [], branch: "kapi/investigate",
      });
    }
    const next = script[i++]!;
    void req;
    return {
      text: "", toolCalls: [{ toolCallId: `c${i}`, toolName: next.tool, input: next.input }],
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      provider: "mock", modelId: "mock", budgetExhausted: false,
    };
  };

  const outcome = await runLoop({
    system: "captain", brief: "adapt", tools: CAPTAIN_TOOLS, ctx: cap.ctx, callModel,
  });
  assert(outcome.ok, `the captain finished: ${outcome.summary}`);

  const events = await store.listEvents(cap.seeded.runId, 0);
  const spawns = events.filter((e) => e.kind === "agent.spawned");
  equal(spawns.length, 2, "it spawned twice");

  const firstChildDone = events.find(
    (e) => e.kind === "job.status" && e.payload.status === "succeeded",
  );
  assert(firstChildDone, "the first child reported");
  assert(
    spawns[1]!.seq > firstChildDone!.seq,
    `the second spawn came AFTER the first result ` +
    `(spawn seq ${spawns[1]!.seq} vs result seq ${firstChildDone!.seq})`,
  );

  const second = (await listJobs(handle, cap.seeded.runId))
    .find((j) => j.payload.instruction.includes("follow-on"));
  assert(second, "the follow-on agent exists and was not in any up-front plan");
});

await test("a refused spawn is reported to the model rather than thrown", async () => {
  const cap = await captainOnRun({ maxTotalSpawns: 1 });
  const seen: string[] = [];
  let step = 0;

  const callModel = async (req: { messages: WireMessage[] }): Promise<ModelResponse> => {
    seen.push(JSON.stringify(req.messages));
    const next = step++ === 0
      ? { tool: "spawn_agents", input: { agents: [{ role: "backend", instruction: "over budget" }] } }
      : { tool: "finish", input: { summary: "worked within the budget" } };
    return {
      text: "", toolCalls: [{ toolCallId: `c${step}`, toolName: next.tool, input: next.input }],
      finishReason: "tool-calls",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provider: "mock", modelId: "mock", budgetExhausted: false,
    };
  };

  const outcome = await runLoop({
    system: "captain", brief: "try", tools: CAPTAIN_TOOLS, ctx: cap.ctx, callModel,
  });
  assert(outcome.ok, "the run survived the refusal");
  assert(
    seen.at(-1)!.includes("budget"),
    "the captain was told about the budget and could plan around it",
  );
});

hub.close();
server.close();
await handle.close();
report();
