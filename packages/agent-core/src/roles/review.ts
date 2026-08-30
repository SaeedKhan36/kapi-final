import {
  ReviewVerdictSchema, normaliseVerdict, type ReviewFinding, type ReviewVerdict,
} from "@kapi/protocol";
import type { AgentTool } from "../types.ts";
import { grepTool, listFiles, readFileTool } from "../tools/fs.ts";
import { clamp } from "../tools/fs.ts";
import { detectTestCommand, shell } from "../tools/shell.ts";

/**
 * Shows only the candidate branch's changes from its merge-base with base.
 * This is deliberately a dedicated tool: the general command tool can write,
 * while a reviewer must be unable to modify the checkout it is judging.
 */
export const inspectDiffTool: AgentTool = {
  name: "inspect_diff",
  description:
    "Inspect the candidate branch's commits and full diff against its base branch. " +
    "Call this before reviewing individual files.",
  inputSchema: {
    type: "object",
    properties: {
      base_branch: {
        type: "string",
        description: "The branch the candidate will merge into. Defaults to main.",
      },
      path: {
        type: "string",
        description: "Optional repository-relative path to limit the diff.",
      },
    },
  },
  async run(input, ctx) {
    const base = String(input.base_branch ?? "main").trim();
    const path = input.path === undefined ? "" : String(input.path).trim();
    if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-") || base.includes("..")) {
      return { ok: false, output: `ERROR: invalid base branch ${JSON.stringify(base)}.` };
    }
    if (path && (path.startsWith("/") || path.split("/").includes(".."))) {
      return { ok: false, output: `ERROR: path escapes the repository: ${path}` };
    }

    // The target branch was cloned directly. Fetch only the named base so a
    // shallow review checkout still has the comparison point it needs.
    const fetched = await shell(ctx.cwd, `git fetch --quiet origin ${JSON.stringify(base)} --depth=100`);
    if (fetched.exitCode !== 0) {
      return { ok: false, output: `ERROR fetching ${base}: ${clamp(fetched.stderr || fetched.stdout)}` };
    }

    const baseRef = "FETCH_HEAD";
    const suffix = path ? ` -- ${JSON.stringify(path)}` : "";
    const [commits, stat, diff] = await Promise.all([
      shell(ctx.cwd, `git log --oneline --no-decorate ${baseRef}..HEAD`),
      shell(ctx.cwd, `git diff --stat ${baseRef}...HEAD${suffix}`),
      shell(ctx.cwd, `git diff --no-ext-diff --unified=40 ${baseRef}...HEAD${suffix}`),
    ]);
    if (diff.exitCode !== 0) {
      return { ok: false, output: `ERROR reading diff: ${clamp(diff.stderr || diff.stdout)}` };
    }
    return {
      output: clamp([
        "COMMITS", commits.stdout.trim() || "(none)",
        "", "STAT", stat.stdout.trim() || "(no changed files)",
        "", "DIFF", diff.stdout.trim() || "(empty diff)",
      ].join("\n")),
    };
  },
};

function findingFrom(value: unknown): ReviewFinding {
  const finding = (value ?? {}) as Record<string, unknown>;
  return {
    severity: String(finding.severity ?? "minor") as ReviewFinding["severity"],
    ...(finding.file ? { file: String(finding.file) } : {}),
    issue: String(finding.issue ?? ""),
    ...(finding.suggestion ? { suggestion: String(finding.suggestion) } : {}),
  };
}

/** The reviewer's only terminal: structured evidence, never an unparsed paragraph. */
export const submitVerdictTool: AgentTool = {
  name: "submit_verdict",
  terminal: true,
  description:
    "Submit the final structured review. This ends the review. Blocking or major findings " +
    "must include a concrete suggested fix. Findings override an inconsistent decision.",
  inputSchema: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "request_changes"] },
      summary: { type: "string", description: "Concise overall assessment." },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
            file: { type: "string" },
            issue: { type: "string" },
            suggestion: { type: "string" },
          },
          required: ["severity", "issue"],
        },
      },
      acceptance_met: {
        type: "array",
        items: { type: "boolean" },
        description: "One boolean per acceptance criterion, in the order given.",
      },
    },
    required: ["decision", "summary", "findings", "acceptance_met"],
  },
  async run(input) {
    const candidate = {
      decision: input.decision,
      summary: input.summary,
      findings: Array.isArray(input.findings) ? input.findings.map(findingFrom) : [],
      acceptanceMet: Array.isArray(input.acceptance_met)
        ? input.acceptance_met.map(Boolean)
        : Array.isArray(input.acceptanceMet) ? input.acceptanceMet.map(Boolean) : [],
    };
    const parsed = ReviewVerdictSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        output: `ERROR: invalid verdict: ${parsed.error.issues.map((issue) =>
          `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      };
    }

    const missingFix = parsed.data.findings.find((finding) =>
      (finding.severity === "blocker" || finding.severity === "major") &&
      !finding.suggestion?.trim()
    );
    if (missingFix) {
      return {
        ok: false,
        output: `ERROR: the ${missingFix.severity} finding "${missingFix.issue}" needs a suggested fix.`,
      };
    }

    const verdict = normaliseVerdict(parsed.data);
    return {
      output: `${verdict.decision}: ${verdict.summary}`,
      meta: { verdict },
    };
  },
};

/** Runs only the repository's detected test command; reviewers cannot supply shell text. */
export const reviewTestsTool: AgentTool = {
  name: "run_tests",
  description: "Run the repository's detected test suite without accepting an arbitrary command.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    const command = await detectTestCommand(ctx.cwd);
    if (!command) return { ok: false, output: "No test command could be detected." };
    ctx.log(`running review tests: ${command}`);
    const result = await shell(ctx.cwd, command);
    return {
      ok: result.exitCode === 0,
      output: clamp([
        `$ ${command}`,
        `exit code: ${result.exitCode}`,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
      ].filter(Boolean).join("\n")),
      meta: { command, exitCode: result.exitCode },
    };
  },
};

/** No editor, generic shell, commit, push, or PR tools appear here. */
export const REVIEW_TOOLS: AgentTool[] = [
  inspectDiffTool, listFiles, readFileTool, grepTool, reviewTestsTool, submitVerdictTool,
];

export const REVIEW_SYSTEM = `You are a Review Agent. You independently inspect one candidate branch and decide whether it is safe and complete. You never modify code.

Review method:
- Start with inspect_diff against the stated base. Review the actual diff, not the task description.
- Read surrounding code where needed to verify behavior, invariants, and error paths.
- Run focused tests when they materially increase confidence. You may not edit, commit, push, or open a pull request.
- Judge correctness, security, regressions, and every acceptance criterion. Do not block on taste or formatting.
- A blocker or major finding must identify a concrete defect and give an actionable fix. Minor findings and nits do not block approval.
- Finish only with submit_verdict. Its reconciliation is authoritative: blocking evidence overrides an accidental approve, while nits alone cannot force request_changes.

You report evidence. You do not spawn a fixer or prescribe a workflow; the Captain receives your verdict and decides what happens next.`;

export function reviewBrief(args: {
  instruction: string;
  acceptance: string[];
  repoUrl?: string | null;
  baseBranch: string;
  branch: string;
  prUrl?: string | null;
}): string {
  return [
    "# Review target",
    args.instruction,
    "",
    `Candidate branch: ${args.branch}`,
    `Base branch: ${args.baseBranch}`,
    args.prUrl ? `Pull request: ${args.prUrl}` : "",
    args.repoUrl ? `Repository: ${args.repoUrl}` : "",
    "",
    args.acceptance.length
      ? `## Acceptance criteria\n${args.acceptance.map((criterion, index) =>
          `${index + 1}. ${criterion}`).join("\n")}`
      : "## Acceptance criteria\nNone were supplied; judge the requested behavior and regressions.",
    "",
    "Inspect the diff first, validate what matters, then call submit_verdict.",
  ].filter(Boolean).join("\n");
}

export function verdictFromOutcome(meta: Record<string, unknown> | undefined): ReviewVerdict | null {
  const parsed = ReviewVerdictSchema.safeParse(meta?.verdict);
  return parsed.success ? normaliseVerdict(parsed.data) : null;
}
