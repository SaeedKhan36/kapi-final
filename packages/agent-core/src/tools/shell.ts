import { spawn } from "node:child_process";
import type { AgentTool, ToolContext } from "../types.ts";
import { clamp } from "./fs.ts";

const COMMAND_TIMEOUT_MS = Number(process.env.KAPI_COMMAND_TIMEOUT_MS ?? 300_000);

export type ShellResult = { exitCode: number; stdout: string; stderr: string };

/** Runs a shell command in the repo. The one place a subprocess is spawned. */
export function shell(
  cwd: string, command: string, timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<ShellResult> {
  return new Promise((resolveShell) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveShell({ exitCode, stdout, stderr });
    };

    // Without this a hung `npm install` or a command waiting on stdin holds the
    // whole job until its lease expires.
    const timer = setTimeout(() => {
      stderr += `\n[kapi] command exceeded ${timeoutMs}ms and was killed\n`;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => { stderr += String(err); finish(127); });
    child.on("close", (code) => finish(code ?? 0));
  });
}

const render = (res: ShellResult) =>
  clamp([
    `exit code: ${res.exitCode}`,
    res.stdout && `stdout:\n${res.stdout}`,
    res.stderr && `stderr:\n${res.stderr}`,
  ].filter(Boolean).join("\n"));

export const runCommandTool: AgentTool = {
  name: "run_command",
  description:
    "Run a shell command in the repository root. Use it to install dependencies, " +
    "build, lint, or inspect. Do NOT run git commands - use the git tools.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  async run(input, ctx: ToolContext) {
    const command = String(input.command ?? "");
    // Git is managed through dedicated tools so that branch, author and push
    // credentials stay consistent and the loop can track what was committed.
    if (/^\s*git(\s|$)/.test(command)) {
      return {
        ok: false,
        output: "ERROR: git is managed for you. Use git_commit, git_push, or open_pr.",
      };
    }
    const res = await shell(ctx.cwd, command);
    return { output: render(res), ok: res.exitCode === 0, meta: { exitCode: res.exitCode } };
  },
};

/**
 * Runs the project's tests, discovering how without being told.
 *
 * An agent that has to guess the test command wastes turns on `npm test` in a
 * Python repo. Detection is cheap and the guess is usually right.
 */
export const runTestsTool: AgentTool = {
  name: "run_tests",
  description:
    "Run the project's test suite. Detects the command from the repository when " +
    "you do not supply one.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Override the detected test command." },
    },
  },
  async run(input, ctx) {
    const explicit = input.command ? String(input.command) : null;
    const command = explicit ?? (await detectTestCommand(ctx.cwd));
    if (!command) {
      return {
        ok: false,
        output: "No test command could be detected. Pass one explicitly if the project has tests.",
      };
    }
    ctx.log(`running tests: ${command}`);
    const res = await shell(ctx.cwd, command);
    return {
      output: `$ ${command}\n${render(res)}`,
      ok: res.exitCode === 0,
      meta: { command, exitCode: res.exitCode },
    };
  },
};

export async function detectTestCommand(cwd: string): Promise<string | null> {
  const probe = await shell(cwd, "ls -1 2>/dev/null", 10_000);
  const files = new Set(probe.stdout.split("\n").map((f) => f.trim()));

  if (files.has("package.json")) {
    const read = await shell(cwd, "cat package.json", 10_000);
    try {
      const pkg = JSON.parse(read.stdout) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        const runner = files.has("pnpm-lock.yaml") ? "pnpm"
          : files.has("yarn.lock") ? "yarn"
          : "npm run";
        return `${runner} test`;
      }
    } catch { /* an unparsable package.json is not a test command */ }
  }
  if (files.has("pytest.ini") || files.has("pyproject.toml") || files.has("tests")) {
    return "python -m pytest -q";
  }
  if (files.has("go.mod")) return "go test ./...";
  if (files.has("Cargo.toml")) return "cargo test";
  if (files.has("Makefile")) return "make test";
  return null;
}
