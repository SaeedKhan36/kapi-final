import { loadEnv } from "@kapi/env";
loadEnv();

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelResponse, WireMessage } from "@kapi/protocol";
import {
  BUILD_TOOLS, REVIEW_TOOLS, compact, editFileTool, gitCommitTool, grepTool,
  inspectDiffTool, listFiles, prepareRepo, readFileTool, runLoop, runTestsTool,
  submitVerdictTool, verdictFromOutcome, writeFileTool,
  detectTestCommand, shell, type ToolContext,
} from "@kapi/agent-core";
import { assert, equal, group, report, test } from "./harness.ts";

const run = promisify(execFile);

async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kapi-core-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@kapi.local"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# scratch\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.js"), "export function hello() {\n  return 'hi';\n}\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const logs: string[] = [];
function ctxFor(cwd: string, jobId = "job_test"): ToolContext {
  return {
    cwd,
    jobId,
    runId: "run_test",
    log: (m) => logs.push(m),
    gitCredentials: async () => { throw new Error("no credential in this test"); },
    askCaptain: async () => null,
  };
}

/* ------------------------------------------------------------------ */

group("filesystem tools");

const repo = await scratchRepo();
const ctx = ctxFor(repo);

await test("list_files sees the repo and hides noise", async () => {
  await mkdir(join(repo, "node_modules", "junk"), { recursive: true });
  await writeFile(join(repo, "node_modules", "junk", "index.js"), "x");
  const res = await listFiles.run({ dir: "." }, ctx);
  assert(res.output.includes("src/app.js"), "sees source");
  assert(!res.output.includes("node_modules"), "excludes node_modules");
});

await test("read_file returns content, and says so when it cannot", async () => {
  const ok = await readFileTool.run({ path: "src/app.js" }, ctx);
  assert(ok.output.includes("hello"), "read the file");
  const bad = await readFileTool.run({ path: "nope.js" }, ctx);
  equal(bad.ok, false, "failure is reported");
  assert(bad.output.startsWith("ERROR"), "and is legible to a model");
});

await test("a path escaping the repository is refused", async () => {
  const res = await readFileTool.run({ path: "../../../etc/passwd" }, ctx);
  equal(res.ok, false, "refused");
  assert(res.output.includes("escapes the repository"), `says why: ${res.output}`);
});

await test("edit_file requires the match to be unique", async () => {
  await writeFile(join(repo, "dup.txt"), "same\nsame\n");
  const ambiguous = await editFileTool.run({ path: "dup.txt", old: "same", new: "other" }, ctx);
  equal(ambiguous.ok, false, "ambiguous edit refused");
  assert(ambiguous.output.includes("appears 2 times"), "explains the ambiguity");

  const missing = await editFileTool.run({ path: "dup.txt", old: "absent", new: "x" }, ctx);
  equal(missing.ok, false, "a non-matching edit is refused rather than silently doing nothing");

  const good = await editFileTool.run({
    path: "src/app.js", old: "return 'hi';", new: "return 'hello';",
  }, ctx);
  assert(good.ok !== false, "a unique edit applies");
  const after = await readFile(join(repo, "src", "app.js"), "utf8");
  assert(after.includes("hello"), "the file actually changed");
});

await test("write_file creates missing directories", async () => {
  const res = await writeFileTool.run({ path: "a/b/c.txt", content: "deep" }, ctx);
  assert(res.ok !== false, "wrote");
  equal(await readFile(join(repo, "a/b/c.txt"), "utf8"), "deep", "content landed");
});

await test("grep finds matches and reports none without erroring", async () => {
  const hit = await grepTool.run({ pattern: "hello" }, ctx);
  assert(hit.output.includes("src/app.js"), "found it");
  const miss = await grepTool.run({ pattern: "zzz-not-here-zzz" }, ctx);
  equal(miss.output, "(no matches)", "no matches is not a failure");
});

/* ------------------------------------------------------------------ */

group("shell and tests");

await test("run_command refuses git and directs to the git tools", async () => {
  const { runCommandTool } = await import("@kapi/agent-core");
  const res = await runCommandTool.run({ command: "git status" }, ctx);
  equal(res.ok, false, "refused");
  assert(res.output.includes("git_commit"), "points at the right tool");
});

await test("run_command reports a non-zero exit as a failure", async () => {
  const { runCommandTool } = await import("@kapi/agent-core");
  const ok = await runCommandTool.run({ command: "echo hi" }, ctx);
  assert(ok.ok !== false && ok.output.includes("hi"), "success is success");
  const bad = await runCommandTool.run({ command: "exit 3" }, ctx);
  equal(bad.ok, false, "failure is failure");
  assert(bad.output.includes("exit code: 3"), "and the code is visible");
});

await test("a hanging command is killed rather than holding the job", async () => {
  const res = await shell(repo, "sleep 30", 800);
  assert(res.stderr.includes("was killed"), `timed out: ${res.stderr.slice(0, 80)}`);
});

await test("the test command is detected from the project", async () => {
  equal(await detectTestCommand(repo), null, "a repo with no tests has no command");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "scratch", scripts: { test: "node -e \"process.exit(0)\"" } }),
  );
  equal(await detectTestCommand(repo), "npm run test", "npm project detected");

  const res = await runTestsTool.run({}, ctx);
  assert(res.ok !== false, `tests ran: ${res.output.slice(0, 120)}`);
});

/* ------------------------------------------------------------------ */

group("git");

await test("prepareRepo puts the agent on its own branch", async () => {
  const result = await prepareRepo(ctxFor(repo, "job_branchy"), null, { baseBranch: "main" });
  assert(result.ok, `prepared: ${result.detail}`);
  equal(result.branch, "kapi/job_branchy", "branch is named after the job");
  const current = await shell(repo, "git rev-parse --abbrev-ref HEAD");
  equal(current.stdout.trim(), "kapi/job_branchy", "and is checked out");
});

await test("git_commit refuses an empty commit and records a real one", async () => {
  const clean = await shell(repo, "git add -A && git commit -qm wip");
  assert(clean.exitCode === 0 || true, "tree committed for the test");

  const empty = await gitCommitTool.run({ message: "nothing" }, ctx);
  equal(empty.ok, false, "nothing to commit is refused");

  await writeFile(join(repo, "src", "new.js"), "export const x = 1;\n");
  const res = await gitCommitTool.run({ message: "add x" }, ctx);
  assert(res.ok !== false, `committed: ${res.output}`);
  assert(typeof res.meta?.sha === "string", "a sha came back");
  assert((res.meta?.files as string[]).includes("src/new.js"), "and the file list");
});

await test("build artefacts are kept out of commits", async () => {
  await mkdir(join(repo, "dist"), { recursive: true });
  await writeFile(join(repo, "dist", "bundle.js"), "huge");
  await writeFile(join(repo, "src", "real.js"), "export const y = 2;\n");
  const res = await gitCommitTool.run({ message: "add y" }, ctx);
  const files = (res.meta?.files as string[]) ?? [];
  assert(files.includes("src/real.js"), "source committed");
  assert(!files.some((f) => f.startsWith("dist/")), `dist excluded, got ${files.join(",")}`);
});

/* ------------------------------------------------------------------ */

group("context compaction");

await test("old steps keep their actions but lose their payloads", () => {
  const messages: WireMessage[] = [{ role: "user", content: "the brief" }];
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: `f${i}.ts` } }],
    });
    messages.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${i}`, output: "x".repeat(5000) }],
    });
  }

  const { messages: out, summary } = compact(messages, 3);
  equal(out[0]!.content, "the brief", "the brief always survives");
  assert(out.length < messages.length, `compacted ${messages.length} -> ${out.length}`);
  assert(summary.includes("read_file: f0.ts"), "the earliest action is still named");
  assert(summary.includes("read_file: f6.ts"), "and the last dropped one");

  const kept = JSON.stringify(out);
  const bigPayloads = (kept.match(/x{5000}/g) ?? []).length;
  equal(bigPayloads, 3, "exactly the recent window keeps full payloads");
});

await test("a short transcript is left alone", () => {
  const messages: WireMessage[] = [
    { role: "user", content: "brief" },
    { role: "assistant", content: [{ type: "tool-call", toolName: "grep", input: {} }] },
    { role: "tool", content: [] },
  ];
  const { messages: out, summary } = compact(messages, 6);
  equal(out.length, 3, "nothing dropped");
  equal(summary, "", "and nothing summarised");
});

/* ------------------------------------------------------------------ */

group("the loop");

/** A model that plays a fixed script of tool calls. */
function scriptedModel(script: Array<{ tool: string; input: Record<string, unknown> }>) {
  let i = 0;
  const seen: WireMessage[][] = [];
  const call = async (req: { messages: WireMessage[] }): Promise<ModelResponse> => {
    seen.push(req.messages);
    const next = script[i++];
    return {
      text: next ? `step ${i}` : "done",
      toolCalls: next
        ? [{ toolCallId: `call_${i}`, toolName: next.tool, input: next.input }]
        : [{ toolCallId: `call_${i}`, toolName: "finish", input: { summary: "script exhausted" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      provider: "mock",
      modelId: "mock",
      budgetExhausted: false,
    };
  };
  return { call, seen, get calls() { return i; } };
}

await test("the loop runs tools and ends when the agent calls finish", async () => {
  const dir = await scratchRepo();
  const model = scriptedModel([
    { tool: "read_file", input: { path: "src/app.js" } },
    { tool: "edit_file", input: { path: "src/app.js", old: "return 'hi';", new: "return 'bye';" } },
    { tool: "git_commit", input: { message: "say bye" } },
    { tool: "finish", input: { summary: "changed the greeting" } },
  ]);

  const outcome = await runLoop({
    system: "you are a test agent",
    brief: "change the greeting",
    tools: BUILD_TOOLS,
    ctx: ctxFor(dir),
    callModel: model.call,
  });

  assert(outcome.ok, `finished cleanly: ${outcome.summary}`);
  equal(outcome.incomplete, false, "not cut off");
  equal(outcome.summary, "changed the greeting", "the agent's own summary is used");
  equal(outcome.steps, 4, "one step per model call");
  assert(outcome.filesTouched.includes("src/app.js"), "tracked the edited file");
  assert(outcome.commits.length === 1, "tracked the commit");
  assert((await readFile(join(dir, "src/app.js"), "utf8")).includes("bye"), "the repo really changed");
});

await test("an unknown tool is reported to the model, not thrown", async () => {
  const dir = await scratchRepo();
  const model = scriptedModel([
    { tool: "teleport", input: {} },
    { tool: "finish", input: { summary: "recovered" } },
  ]);
  const outcome = await runLoop({
    system: "s", brief: "b", tools: BUILD_TOOLS, ctx: ctxFor(dir), callModel: model.call,
  });
  assert(outcome.ok, "the loop survived");
  const transcript = JSON.stringify(model.seen.at(-1));
  assert(transcript.includes("no such tool"), "the model was told");
  assert(transcript.includes("teleport"), "and which tool it was");
});

await test("a throwing tool does not kill the job", async () => {
  const dir = await scratchRepo();
  const exploding = {
    name: "explode", description: "", inputSchema: { type: "object", properties: {} },
    run: async () => { throw new Error("kaboom"); },
  };
  const model = scriptedModel([
    { tool: "explode", input: {} },
    { tool: "finish", input: { summary: "carried on" } },
  ]);
  const outcome = await runLoop({
    system: "s", brief: "b",
    tools: [exploding, ...BUILD_TOOLS], ctx: ctxFor(dir), callModel: model.call,
  });
  assert(outcome.ok, "the loop recovered");
  assert(JSON.stringify(model.seen.at(-1)).includes("kaboom"), "the model saw the error");
});

await test("the step cap stops the loop and asks for a landing", async () => {
  const dir = await scratchRepo();
  const model = scriptedModel(
    Array.from({ length: 20 }, () => ({ tool: "list_files", input: { dir: "." } })),
  );
  const outcome = await runLoop({
    system: "s", brief: "b", tools: BUILD_TOOLS, ctx: ctxFor(dir),
    callModel: model.call, maxSteps: 4,
  });
  equal(outcome.ok, false, "did not finish");
  equal(outcome.incomplete, true, "and says it was cut off");
  equal(outcome.steps, 4, "stopped at the cap");
  assert(outcome.summary.includes("4-step limit"), `explains itself: ${outcome.summary}`);
  assert(
    JSON.stringify(model.seen.at(-1)).includes("Do not start anything new"),
    "the final call asked it to land",
  );
});

await test("a lost lease stops the loop between steps", async () => {
  const dir = await scratchRepo();
  let alive = true;
  const model = scriptedModel(
    Array.from({ length: 10 }, () => ({ tool: "list_files", input: { dir: "." } })),
  );
  const outcome = await runLoop({
    system: "s", brief: "b", tools: BUILD_TOOLS, ctx: ctxFor(dir),
    callModel: async (req) => { alive = false; return model.call(req); },
    alive: () => alive,
    maxSteps: 10,
  });
  assert(outcome.steps <= 2, `stopped promptly, took ${outcome.steps}`);
  assert(outcome.summary.includes("lease lost"), `says why: ${outcome.summary}`);
});

await test("an exhausted budget lands the agent instead of looping", async () => {
  const dir = await scratchRepo();
  const outcome = await runLoop({
    system: "s", brief: "b", tools: BUILD_TOOLS, ctx: ctxFor(dir),
    callModel: async (): Promise<ModelResponse> => ({
      text: "", toolCalls: [{ toolCallId: "c", toolName: "list_files", input: { dir: "." } }],
      finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      provider: "mock", modelId: "mock", budgetExhausted: true,
    }),
    maxSteps: 20,
  });
  equal(outcome.steps, 1, "stopped as soon as the plane said the budget was gone");
  assert(outcome.summary.includes("budget"), `explains itself: ${outcome.summary}`);
});

await test("checkpoints are written each step and can resume the loop", async () => {
  const dir = await scratchRepo();
  const saved: unknown[] = [];
  const first = scriptedModel([
    { tool: "read_file", input: { path: "src/app.js" } },
    { tool: "list_files", input: { dir: "src" } },
  ]);

  const cut = await runLoop({
    system: "s", brief: "the original brief", tools: BUILD_TOOLS, ctx: ctxFor(dir),
    callModel: first.call, maxSteps: 2,
    onCheckpoint: async (c) => { saved.push(structuredClone(c)); },
  });
  equal(cut.ok, false, "the first attempt was cut off");
  equal(saved.length, 2, "a checkpoint per step");

  const resumed = scriptedModel([{ tool: "finish", input: { summary: "finished after resume" } }]);
  const outcome = await runLoop({
    system: "s", brief: "the original brief", tools: BUILD_TOOLS, ctx: ctxFor(dir),
    callModel: resumed.call,
    resumeFrom: saved.at(-1) as never,
  });

  assert(outcome.ok, "the resumed run finished");
  equal(outcome.summary, "finished after resume", "with its own summary");
  assert(outcome.steps > 2, `step count carried over, got ${outcome.steps}`);
  // The whole point: it did not start over.
  const transcript = JSON.stringify(resumed.seen[0]);
  assert(transcript.includes("src/app.js"), "the resumed model saw the earlier work");
});

/* ------------------------------------------------------------------ */

group("review agent tools");

await test("the review toolset cannot edit, commit, push, or run arbitrary commands", () => {
  const names = REVIEW_TOOLS.map((tool) => tool.name);
  assert(names.includes("inspect_diff") && names.includes("submit_verdict"), "review primitives present");
  for (const unsafe of ["write_file", "edit_file", "run_command", "git_commit", "git_push", "open_pr"]) {
    assert(!names.includes(unsafe), `${unsafe} is not available to a reviewer`);
  }
  equal(submitVerdictTool.terminal, true, "the structured verdict ends the loop");
});

await test("submit_verdict reconciles an approve that contains a blocker", async () => {
  const result = await submitVerdictTool.run({
    decision: "approve",
    summary: "looks good except for an authorization bypass",
    findings: [{
      severity: "blocker",
      file: "src/auth.ts",
      issue: "the route accepts an unauthenticated caller",
      suggestion: "require the verified principal before dispatch",
    }],
    acceptance_met: [false],
  }, ctx);
  assert(result.ok !== false, `verdict accepted: ${result.output}`);
  const verdict = verdictFromOutcome(result.meta);
  equal(verdict?.decision, "request_changes", "blocking evidence overrides approve");
  equal(verdict?.acceptanceMet[0], false, "acceptance evidence is preserved");
});

await test("a blocking finding without a fix is refused before the loop can end", async () => {
  const result = await submitVerdictTool.run({
    decision: "request_changes",
    summary: "a crash remains",
    findings: [{ severity: "major", issue: "null input throws" }],
    acceptance_met: [false],
  }, ctx);
  equal(result.ok, false, "not terminally accepted");
  assert(result.output.includes("suggested fix"), `actionable error: ${result.output}`);
});

await test("inspect_diff shows candidate changes without giving the reviewer git shell access", async () => {
  const dir = await scratchRepo();
  const remote = await mkdtemp(join(tmpdir(), "kapi-review-remote-"));
  await run("git", ["init", "--bare", "-q"], { cwd: remote });
  await run("git", ["remote", "add", "origin", remote], { cwd: dir });
  await run("git", ["push", "-q", "-u", "origin", "main"], { cwd: dir });
  await run("git", ["checkout", "-qb", "kapi/candidate"], { cwd: dir });
  await writeFile(join(dir, "src", "app.js"), "export const reviewed = true;\n");
  await run("git", ["add", "src/app.js"], { cwd: dir });
  await run("git", ["commit", "-qm", "candidate change"], { cwd: dir });

  const result = await inspectDiffTool.run({ base_branch: "main" }, ctxFor(dir));
  assert(result.ok !== false, `diff read: ${result.output.slice(0, 160)}`);
  assert(result.output.includes("candidate change"), "commit list is visible");
  assert(result.output.includes("reviewed = true"), "the actual patch is visible");
});

await test("the loop returns the terminal verdict as structured metadata", async () => {
  const dir = await scratchRepo();
  const model = scriptedModel([{ tool: "submit_verdict", input: {
    decision: "request_changes",
    summary: "one correctness problem",
    findings: [{
      severity: "major", issue: "empty input crashes", suggestion: "handle the empty case",
    }],
    acceptance_met: [false],
  } }]);
  const outcome = await runLoop({
    system: "review", brief: "review it", tools: REVIEW_TOOLS,
    ctx: ctxFor(dir), callModel: model.call,
  });
  assert(outcome.ok, "submit_verdict completed the review loop");
  equal(verdictFromOutcome(outcome.terminalMeta)?.decision, "request_changes", "structured result returned");
});

report();
