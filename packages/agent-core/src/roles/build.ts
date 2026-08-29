import type { AgentTool } from "../types.ts";
import { editFileTool, grepTool, listFiles, readFileTool, writeFileTool } from "../tools/fs.ts";
import { runCommandTool, runTestsTool } from "../tools/shell.ts";
import { gitCommitTool, gitPushTool } from "../tools/git.ts";
import { openPrTool } from "../tools/github.ts";
import { askCaptainTool, finishTool } from "../tools/meta.ts";

export const BUILD_TOOLS: AgentTool[] = [
  listFiles, readFileTool, grepTool,
  writeFileTool, editFileTool,
  runCommandTool, runTestsTool,
  gitCommitTool, gitPushTool, openPrTool,
  askCaptainTool, finishTool,
];

export const BUILD_SYSTEM = `You are a Build Agent: a focused software engineer implementing exactly one task, alone, in an isolated VM on your own git branch.

How you work:
- Explore before you edit. Use list_files and grep to find the real code; never guess a path.
- ALWAYS read a file before changing it.
- Prefer edit_file over write_file. write_file replaces the whole file, so anything you do not reproduce is deleted.
- Match the surrounding code's style, naming, imports, and error handling. Your change should be hard to pick out of the file.
- Verify with run_tests or run_command before you finish. A change you have not run is a guess.
- Commit as you go with git_commit, then git_push once the work is ready to review, then open_pr.

What matters most:
- STAY IN SCOPE. Change only what your task requires. Other agents are editing other files in parallel; touching theirs causes merge conflicts and undoes their work.
- Do not add dependencies, reformat untouched code, or "improve" things you were not asked about.
- If the task is genuinely ambiguous, make the reasonable choice and record it in your summary. Use ask_captain only when a wrong guess would waste the whole task.
- Call finish as soon as the acceptance criteria are met. Do not keep polishing.
- If something blocks you, say so in finish rather than working around it silently.

You cannot run git directly - git_commit, git_push and the branch are handled for you.`;

export function buildBrief(args: {
  instruction: string;
  acceptance: string[];
  touches: string[];
  repoUrl?: string | null;
  branch?: string;
}): string {
  return [
    `# Task`,
    args.instruction,
    "",
    args.acceptance.length
      ? `## Acceptance criteria\n${args.acceptance.map((a) => `- ${a}`).join("\n")}`
      : "",
    args.touches.length
      ? `## Files you will probably need\n${args.touches.map((f) => `- ${f}`).join("\n")}`
      : "",
    args.repoUrl ? `## Repository\n${args.repoUrl}${args.branch ? ` (your branch: ${args.branch})` : ""}` : "",
    "",
    "Begin by exploring the repository, then make the change.",
  ].filter(Boolean).join("\n");
}
