import {
  AgentIdSchema, AgentRoleSchema, agentId, jobIdOf, newId,
  JobSpecSchema, JobResultSchema, JobStatusSchema, isJobTerminal, isJobLeased,
  AgentEventSchema, EventKindSchema, AgentInboxMessageSchema,
  ReviewVerdictSchema, normaliseVerdict, blockingFindings, renderChangeRequest,
} from "@kapi/protocol";
import { assert, equal, group, report, test } from "./harness.ts";

group("ids");

await test("newId is sortable by creation time", async () => {
  const a = newId("job");
  await new Promise((r) => setTimeout(r, 2));
  const b = newId("job");
  assert(a < b, `expected ${a} < ${b}`);
  assert(a.startsWith("job_"), "prefix is applied");
});

await test("agent addressing round-trips through a job id", () => {
  const id = newId("job");
  const addr = agentId(id);
  assert(AgentIdSchema.safeParse(addr).success, `${addr} should be a valid AgentId`);
  equal(jobIdOf(addr), id, "job id survives the round trip");
});

await test("two agents in the same role get distinct addresses", () => {
  // The failure that forced this scheme: kapi-old addressed by role slug, so a
  // captain spawning two backend agents produced one address for both.
  const a = agentId(newId("job"));
  const b = agentId(newId("job"));
  assert(a !== b, "same-role agents must not collide");
});

await test("well-known and malformed addresses", () => {
  for (const ok of ["orchestrator", "captain", "broadcast", "agent:job_abc123"]) {
    assert(AgentIdSchema.safeParse(ok).success, `${ok} should parse`);
  }
  for (const bad of ["worker:backend", "agent:", "agent:UPPER", "", "master"]) {
    assert(!AgentIdSchema.safeParse(bad).success, `${bad} should be rejected`);
  }
});

group("jobs");

await test("JobSpec fills its defaults", () => {
  const spec = JobSpecSchema.parse({
    runId: "run_1", kind: "build", role: "backend", instruction: "add a health endpoint",
  });
  equal(spec.priority, 0, "priority defaults to 0");
  equal(spec.maxAttempts, 3, "maxAttempts defaults to 3");
  equal(spec.dependsOn.length, 0, "dependsOn defaults to empty");
});

await test("JobSpec rejects an unknown role or kind", () => {
  assert(!JobSpecSchema.safeParse({
    runId: "r", kind: "build", role: "wizard", instruction: "x",
  }).success, "unknown role rejected");
  assert(!JobSpecSchema.safeParse({
    runId: "r", kind: "deploy", role: "backend", instruction: "x",
  }).success, "unknown kind rejected");
});

await test("status predicates agree with the enum", () => {
  for (const s of JobStatusSchema.options) {
    const terminal = isJobTerminal(s);
    const leased = isJobLeased(s);
    assert(!(terminal && leased), `${s} cannot be both terminal and leased`);
  }
  assert(isJobTerminal("succeeded") && isJobTerminal("failed") && isJobTerminal("cancelled"), "terminal set");
  assert(isJobLeased("claimed") && isJobLeased("running"), "leased set");
  assert(!isJobTerminal("queued") && !isJobLeased("queued"), "queued is neither");
});

await test("JobResult defaults its collections", () => {
  const r = JobResultSchema.parse({ ok: true, summary: "done" });
  equal(r.filesChanged.length, 0, "filesChanged");
  equal(r.commits.length, 0, "commits");
});

group("events");

await test("AgentEvent requires a run-scoped sequence", () => {
  const ok = AgentEventSchema.safeParse({
    id: "ev_1", runId: "run_1", jobId: "job_1", seq: 0,
    kind: "job.status", from: "orchestrator", ts: new Date().toISOString(),
  });
  assert(ok.success, `should parse: ${JSON.stringify(ok.error?.issues)}`);
  assert(!AgentEventSchema.safeParse({
    id: "ev_1", runId: "run_1", seq: -1, kind: "log", from: "orchestrator",
    ts: new Date().toISOString(),
  }).success, "negative seq rejected");
});

await test("an unlabelled inbox message is read as a worker's question", () => {
  // An agent bundle built before `kind` existed sends none. Defaulting to the
  // question side costs a wasted turn; defaulting the other way would strand a
  // worker waiting for an answer that never comes.
  const legacy = AgentInboxMessageSchema.parse({
    seq: 4, from: "agent:job_1", content: "which branch?",
  });
  equal(legacy.kind, "agent.message", "the safe default");

  const ci = AgentInboxMessageSchema.parse({
    seq: 5, from: "orchestrator", kind: "ci.completed", content: "checks done",
  });
  equal(ci.kind, "ci.completed", "and a labelled one keeps its kind");

  assert(
    !AgentInboxMessageSchema.safeParse({
      seq: 6, from: "orchestrator", kind: "not.a.kind", content: "x",
    }).success,
    "an unknown kind is rejected rather than silently bucketed",
  );
});

await test("every EventKind is namespaced or a bare noun", () => {
  for (const kind of EventKindSchema.options) {
    assert(/^[a-z]+(\.[a-z]+)?$/.test(kind), `${kind} is malformed`);
  }
});

group("review");

await test("a blocker overrides a stated approval", () => {
  // Models routinely say "approve" while listing a blocker. Findings are the
  // evidence, so they win.
  const v = ReviewVerdictSchema.parse({
    decision: "approve",
    summary: "looks fine",
    findings: [{ severity: "blocker", issue: "drops the auth check" }],
  });
  equal(normaliseVerdict(v).decision, "request_changes", "decision flipped");
});

await test("nits alone do not block a merge", () => {
  const v = ReviewVerdictSchema.parse({
    decision: "request_changes",
    summary: "style only",
    findings: [{ severity: "nit", issue: "prefers const" }],
  });
  equal(normaliseVerdict(v).decision, "approve", "nits are advisory");
  equal(blockingFindings(v).length, 0, "no blocking findings");
});

await test("a change request renders actionable instructions", () => {
  const v = ReviewVerdictSchema.parse({
    decision: "request_changes",
    summary: "auth missing",
    findings: [
      { severity: "blocker", file: "src/api.ts", issue: "no auth", suggestion: "check the bearer token" },
      { severity: "nit", issue: "spacing" },
    ],
  });
  const text = renderChangeRequest(v);
  assert(text.includes("src/api.ts"), "names the file");
  assert(text.includes("check the bearer token"), "includes the suggestion");
  assert(!text.includes("spacing"), "omits non-blocking findings");
});

report();
