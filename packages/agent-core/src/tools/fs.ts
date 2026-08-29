import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool, ToolContext } from "../types.ts";

const run = promisify(execFile);

/** Truncation guard. A 200k-line file in the transcript is a budget incident. */
const MAX_OUTPUT = Number(process.env.KAPI_MAX_TOOL_OUTPUT ?? 20_000);

export function clamp(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated, ${text.length - limit} more characters]`;
}

/**
 * Resolves a path inside the checkout, refusing anything that escapes it.
 *
 * The VM is the isolation boundary, but an agent that wanders into `/etc` or
 * `~/.ssh` produces confusing failures and, on the local provider, real damage.
 * Keeping it in the repo is also just correct: its job is that repo.
 */
export function insideRepo(ctx: ToolContext, path: string): string {
  const target = isAbsolute(path) ? path : resolve(ctx.cwd, path);
  const rel = relative(ctx.cwd, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the repository: ${path}`);
  }
  return target;
}

export const listFiles: AgentTool = {
  name: "list_files",
  description:
    "List files under a directory in the repository. Use this before guessing at paths.",
  inputSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Directory relative to the repo root. Defaults to '.'" },
    },
  },
  async run(input, ctx) {
    try {
      const dir = insideRepo(ctx, String(input.dir ?? "."));
      const { stdout } = await run("bash", [
        "-lc",
        `find ${JSON.stringify(dir)} -type f ` +
        `-not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' ` +
        `| head -300 | sed "s|^${ctx.cwd}/||"`,
      ], { maxBuffer: 8 * 1024 * 1024 });
      return { output: clamp(stdout.trim() || "(no files)") };
    } catch (err) {
      return { ok: false, output: `ERROR listing ${input.dir}: ${String(err)}` };
    }
  },
};

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a file. Always read a file before editing it.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async run(input, ctx) {
    try {
      const body = await readFile(insideRepo(ctx, String(input.path)), "utf8");
      return { output: body.trim() ? clamp(body) : "(file is empty)" };
    } catch (err) {
      return {
        ok: false,
        output: `ERROR: cannot read ${input.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const writeFileTool: AgentTool = {
  name: "write_file",
  description:
    "Write a file, replacing its entire contents. Read it first and reproduce anything " +
    "you are not changing. Prefer edit_file for small changes to a large file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  async run(input, ctx) {
    try {
      const target = insideRepo(ctx, String(input.path));
      await mkdir(dirname(target), { recursive: true });
      const content = String(input.content ?? "");
      await writeFile(target, content, "utf8");
      return {
        output: `wrote ${input.path} (${content.split("\n").length} lines)`,
        meta: { path: String(input.path) },
      };
    } catch (err) {
      return { ok: false, output: `ERROR: cannot write ${input.path}: ${String(err)}` };
    }
  },
};

/**
 * Exact-string replacement.
 *
 * Cheaper and far safer than rewriting a whole file: the model does not have to
 * reproduce hundreds of lines it is not touching, which is where whole-file
 * writes quietly delete things.
 */
export const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. `old` must appear exactly once. " +
    "Include enough surrounding context to make it unique.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old: { type: "string", description: "Exact text to replace, including indentation." },
      new: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old", "new"],
  },
  async run(input, ctx) {
    const path = String(input.path);
    try {
      const target = insideRepo(ctx, path);
      const body = await readFile(target, "utf8");
      const old = String(input.old);

      const occurrences = body.split(old).length - 1;
      if (occurrences === 0) {
        return { ok: false, output: `ERROR: that exact text does not appear in ${path}.` };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          output: `ERROR: that text appears ${occurrences} times in ${path}. ` +
                  `Add surrounding context so it matches exactly once.`,
        };
      }

      await writeFile(target, body.replace(old, String(input.new)), "utf8");
      return { output: `edited ${path}`, meta: { path } };
    } catch (err) {
      return { ok: false, output: `ERROR: cannot edit ${path}: ${String(err)}` };
    }
  },
};

export const grepTool: AgentTool = {
  name: "grep",
  description: "Search the repository for a pattern. Faster than reading files to find things.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      dir: { type: "string", description: "Where to search. Defaults to the repo root." },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    try {
      const dir = insideRepo(ctx, String(input.dir ?? "."));
      const { stdout } = await run("bash", [
        "-lc",
        `grep -rn --binary-files=without-match ` +
        `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist ` +
        `-- ${JSON.stringify(String(input.pattern))} ${JSON.stringify(dir)} ` +
        `| head -100 | sed "s|^${ctx.cwd}/||"`,
      ], { maxBuffer: 8 * 1024 * 1024 });
      return { output: clamp(stdout.trim() || "(no matches)") };
    } catch {
      // grep exits 1 on no matches, which is not an error worth reporting as one.
      return { output: "(no matches)" };
    }
  },
};
