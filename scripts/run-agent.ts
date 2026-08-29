import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createDb } from "@kapi/db";
import { Authenticator } from "@kapi/identity";
import { getJob, listJobs } from "@kapi/queue";
import { enqueue } from "@kapi/queue";
import { newId } from "@kapi/protocol";
import { LocalProvider } from "@kapi/vm";
import { createApp } from "../apps/control-plane/src/app.ts";
import { EventHub } from "../apps/control-plane/src/events.ts";
import { Provisioner } from "../apps/control-plane/src/provisioner.ts";
import { Store } from "../apps/control-plane/src/store.ts";

/**
 * Drives one agent job end to end, in process.
 *
 * The whole stack really runs: the control plane, the queue, a VM, the agent
 * binary inside it, and real model calls proxied back through the plane. The
 * only shortcut is that the plane is hosted here rather than deployed.
 *
 *   pnpm run:agent --repo=<git url or path> --goal="..." [--role=build] [--steps=20]
 */
const arg = (name: string, fallback = "") =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

const repo = arg("repo");
const goal = arg("goal");
// kind selects the agent loop (build | captain | review); role is the
// specialisation label on the job. They are different axes and conflating them
// is a validation error, not a silent mismatch.
const kind = arg("kind", "build");
const role = arg("role", kind === "captain" ? "captain" : kind === "review" ? "review" : "generalist");
const maxSteps = arg("steps", "20");
const branchArg = arg("branch", "main");

if (!repo || !goal) {
  console.error(
    `\n  usage: pnpm run:agent --repo=<url|path> --goal="what to build"\n` +
    `         [--kind=build|captain|review] [--role=backend|frontend|...]\n` +
    `         [--steps=20] [--branch=main] [--timeout=600]\n`,
  );
  process.exit(1);
}

process.env.KAPI_MAX_STEPS = maxSteps;

const handle = await createDb();
const store = new Store(handle);
const hub = new EventHub(store, handle, 400);
const auth = new Authenticator(handle);
const app = createApp({ handle, store, hub, auth, vmProvider: "local" });
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise((r) => setTimeout(r, 200));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const principal = await auth.authenticate();
const project = await store.createProject({
  ownerId: principal.userId,
  name: `cli-${newId().slice(-6)}`,
  repoUrl: repo,
  defaultBranch: branchArg,
});
const thread = await store.createThread(project.id, goal.slice(0, 80));
const run = await store.createRun({ threadId: thread.id, projectId: project.id, goal });

const job = await enqueue(handle, {
  runId: run.id,
  parentJobId: null,
  kind: kind as "build" | "captain" | "review",
  role: role as never,
  instruction: goal,
  acceptance: [],
  touches: [],
  dependsOn: [],
  priority: 10,
  maxAttempts: 1,
  context: { repoUrl: repo, baseBranch: branchArg },
});

console.log(`\n  plane   ${base}`);
console.log(`  db      ${handle.target}`);
console.log(`  run     ${run.id}`);
console.log(`  job     ${job.id}  (${kind}/${role})`);
console.log(`  repo    ${repo}`);
console.log(`  goal    ${goal}\n`);

const provisioner = new Provisioner(handle, {
  provider: new LocalProvider(),
  publicUrl: base,
  onLog: (l) => console.log(`  ${l}`),
});

let cursor = 0;
const printEvents = async () => {
  for (const e of await store.listEvents(run.id, cursor)) {
    cursor = e.seq;
    const p = e.payload as Record<string, unknown>;
    if (e.kind === "log" && p.tool) {
      console.log(`  · ${String(p.tool)} ${JSON.stringify(p.input ?? {}).slice(0, 110)}`);
    } else if (e.kind === "log" && p.kind === "thought") {
      console.log(`  » ${String(p.message).replace(/\n/g, " ").slice(0, 140)}`);
    } else if (e.kind === "log") {
      console.log(`  · ${String(p.message ?? "").slice(0, 140)}`);
    } else if (e.kind === "job.status") {
      console.log(`  [${String(p.status)}]${p.detail ? ` ${String(p.detail).slice(0, 120)}` : ""}`);
    }
  }
};

await provisioner.tick();

const deadline = Date.now() + Number(arg("timeout", "600")) * 1000;
let final = await getJob(handle, job.id);
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  await printEvents();
  final = await getJob(handle, job.id);
  if (final && ["succeeded", "failed", "cancelled"].includes(final.status)) break;
}
await printEvents();

const runRow = await store.getRun(run.id);
console.log(`\n  status   ${final?.status ?? "unknown"}`);
console.log(`  summary  ${final?.result?.summary ?? final?.error ?? "(none)"}`);
console.log(`  branch   ${final?.result?.branch ?? "(none)"}`);
console.log(`  files    ${(final?.result?.filesChanged ?? []).map((f) => f.path).join(", ") || "(none)"}`);
console.log(`  commits  ${(final?.result?.commits ?? []).join(", ") || "(none)"}`);
console.log(`  pr       ${final?.result?.prUrl ?? "(none)"}`);
console.log(`  model    ${runRow?.llmRequests ?? 0} request(s), ${runRow?.llmTokens ?? 0} tokens`);
console.log(`  jobs     ${(await listJobs(handle, run.id)).length}\n`);

await provisioner.destroyAll();
hub.close();
server.close();
await handle.close();
process.exit(final?.status === "succeeded" ? 0 : 1);
