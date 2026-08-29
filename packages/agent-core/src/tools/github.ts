import type { AgentTool } from "../types.ts";
import { branchName, scrub } from "./git.ts";
import { shell } from "./shell.ts";

export type RepoRef = { owner: string; repo: string };

/** Parses the GitHub repo out of a clone URL. Null for anything not GitHub. */
export function parseRepoUrl(url: string): RepoRef | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export async function openPullRequest(
  token: string,
  ref: RepoRef,
  body: { head: string; base: string; title: string; body: string },
): Promise<{ html_url: string; number: number }> {
  const res = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const text = await res.text();
  if (!res.ok) {
    // GitHub returns 422 with a useful message for the common cases: no commits
    // between branches, or a PR that already exists.
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = [parsed.message, ...(parsed.errors ?? []).map((e: { message?: string }) => e.message)]
        .filter(Boolean).join("; ") || detail;
    } catch { /* keep the raw body */ }
    throw new Error(`GitHub ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as { html_url: string; number: number };
}

/**
 * Opens a pull request for the agent's branch.
 *
 * Nothing is merged here. Putting agent work behind a PR - reviewed, with CI
 * run against it - is the entire reason for not letting an agent push to main.
 */
export const openPrTool: AgentTool = {
  name: "open_pr",
  description:
    "Open a pull request for your branch. Push first. Write the description for a " +
    "reviewer who has not seen the task: what changed, and why.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line, imperative." },
      body: { type: "string", description: "What changed and why. Markdown." },
    },
    required: ["title", "body"],
  },
  async run(input, ctx) {
    let creds;
    try {
      creds = await ctx.gitCredentials();
    } catch (err) {
      return {
        ok: false,
        output: `No GitHub credential is available, so no pull request can be opened: ` +
                `${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const ref = creds.repoUrl ? parseRepoUrl(creds.repoUrl) : null;
    if (!ref) {
      return { ok: false, output: `${creds.repoUrl ?? "the project repo"} is not a GitHub repository.` };
    }

    const branch = branchName(ctx.jobId);
    // A PR needs the branch on the remote; an unpushed branch gives GitHub's
    // opaque "not found" rather than anything a model can act on.
    const remote = await shell(ctx.cwd, `git ls-remote --heads origin ${branch}`);
    if (!remote.stdout.includes(branch)) {
      const pushed = await shell(ctx.cwd, "git rev-parse --abbrev-ref @{upstream}");
      if (pushed.exitCode !== 0) {
        return { ok: false, output: "Push your branch with git_push before opening a pull request." };
      }
    }

    try {
      const pr = await openPullRequest(creds.token, ref, {
        head: branch,
        base: creds.baseBranch,
        title: String(input.title ?? "").slice(0, 250) || "kapi: changes",
        body: String(input.body ?? ""),
      });
      return { output: `opened ${pr.html_url}`, meta: { prUrl: pr.html_url, prNumber: pr.number } };
    } catch (err) {
      return {
        ok: false,
        output: scrub(err instanceof Error ? err.message : String(err), creds.token),
      };
    }
  },
};
