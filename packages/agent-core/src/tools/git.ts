import type { AgentTool, GitCredentials, ToolContext } from "../types.ts";
import { shell } from "./shell.ts";

/**
 * Git, handled for the agent rather than by it.
 *
 * The model never runs git itself: branch naming, commit authorship and push
 * credentials have to be consistent for the plane to be able to review, merge
 * and attribute the work, and a token pasted into a shell command by a model is
 * a token in the transcript.
 */

/** Injects credentials into a remote URL for exactly one command. */
function authedRemote(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

/** Redacts a token from anything about to be shown to a model or logged. */
export const scrub = (text: string, token?: string): string =>
  token ? text.split(token).join("***") : text;

export const branchName = (jobId: string) => `kapi/${jobId}`;

export const gitCommitTool: AgentTool = {
  name: "git_commit",
  description:
    "Commit everything currently changed, with a message. Commit whenever a " +
    "coherent piece of work is done rather than saving it all for the end.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Imperative subject line, then optional detail." },
    },
    required: ["message"],
  },
  async run(input, ctx) {
    const message = String(input.message ?? "").trim() || "kapi: update";
    const status = await shell(ctx.cwd, "git status --porcelain");
    if (!status.stdout.trim()) {
      return { ok: false, output: "Nothing to commit - no files have changed." };
    }

    // Build artefacts are the classic accidental commit, and they are enormous.
    //
    // Long-form pathspec magic, not `:!name`: git parses the characters after
    // `:!` as further magic signatures, so `:!__pycache__` fails outright with
    // "Unimplemented pathspec magic '_'".
    const excludes = ["node_modules", "dist", ".next", "target", "__pycache__", ".venv"]
      .map((dir) => `':(exclude)${dir}'`)
      .join(" ");
    const add = await shell(ctx.cwd, `git add -A -- . ${excludes}`);
    if (add.exitCode !== 0) {
      return { ok: false, output: `git add failed:\n${add.stderr || add.stdout}` };
    }

    const commit = await shell(
      ctx.cwd,
      `git commit -m ${JSON.stringify(message)} --no-verify`,
    );
    if (commit.exitCode !== 0) {
      return { ok: false, output: `git commit failed:\n${commit.stderr || commit.stdout}` };
    }

    const sha = (await shell(ctx.cwd, "git rev-parse --short HEAD")).stdout.trim();
    const files = (await shell(ctx.cwd, "git show --name-only --format= HEAD")).stdout
      .split("\n").map((f) => f.trim()).filter(Boolean);

    return {
      output: `committed ${sha}: ${message.split("\n")[0]}\n${files.length} file(s)`,
      meta: { sha, files },
    };
  },
};

export const gitPushTool: AgentTool = {
  name: "git_push",
  description:
    "Push your branch to the remote. Do this once your commits are ready to be reviewed.",
  inputSchema: { type: "object", properties: {} },
  async run(_input, ctx) {
    let creds: GitCredentials;
    try {
      creds = await ctx.gitCredentials();
    } catch (err) {
      return {
        ok: false,
        output:
          `No push credential is available, so the branch stays local to this VM: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!creds.repoUrl) {
      return { ok: false, output: "The project has no remote repository configured." };
    }

    const branch = branchName(ctx.jobId);
    const remote = authedRemote(creds.repoUrl, creds.token);
    // The credential goes on the command line for one push and is never
    // written into .git/config, where it would persist in the VM image.
    const res = await shell(ctx.cwd, `git push --set-upstream ${JSON.stringify(remote)} HEAD:${branch}`);

    const output = scrub(res.stderr || res.stdout, creds.token);
    if (res.exitCode !== 0) return { ok: false, output: `git push failed:\n${output}` };
    return { output: `pushed ${branch}`, meta: { branch } };
  },
};

/**
 * Prepares the checkout: clone, identity, and the agent's own branch.
 *
 * Run before the loop starts rather than exposed as a tool - an agent that can
 * choose not to branch will eventually commit onto main.
 */
export async function prepareRepo(
  ctx: Pick<ToolContext, "cwd" | "jobId" | "log">,
  creds: GitCredentials | null,
  opts: { repoUrl?: string | null; baseBranch?: string; readOnly?: boolean } = {},
): Promise<{ ok: boolean; branch: string; detail: string }> {
  const branch = branchName(ctx.jobId);
  const repoUrl = opts.repoUrl ?? creds?.repoUrl ?? null;
  const base = opts.baseBranch ?? creds?.baseBranch ?? "main";

  const existing = await shell(ctx.cwd, "git rev-parse --is-inside-work-tree");
  if (existing.exitCode !== 0) {
    if (!repoUrl) return { ok: false, branch, detail: "no repository URL to clone" };
    const remote = creds ? authedRemote(repoUrl, creds.token) : repoUrl;
    ctx.log(`cloning ${repoUrl} (${base})`);
    const clone = await shell(
      ctx.cwd,
      `git clone --depth 50 --branch ${JSON.stringify(base)} ${JSON.stringify(remote)} .`,
      600_000,
    );
    if (clone.exitCode !== 0) {
      return {
        ok: false, branch,
        detail: scrub(clone.stderr || clone.stdout, creds?.token).slice(0, 500),
      };
    }
  }

  // A captain clones to read the code, never to change it. Leaving it on the
  // base branch means there is no branch for it to accidentally commit onto.
  if (opts.readOnly) {
    return { ok: true, branch: base, detail: `read-only checkout of ${base}` };
  }

  const identity = creds?.identity ?? { name: "kapi-agent", email: "agent@kapi.local" };
  await shell(ctx.cwd, `git config user.name ${JSON.stringify(identity.name)}`);
  await shell(ctx.cwd, `git config user.email ${JSON.stringify(identity.email)}`);
  // Local to this clone, so a shared credential cache is never written.
  await shell(ctx.cwd, `git config credential.helper ""`);

  const checkout = await shell(ctx.cwd, `git checkout -B ${JSON.stringify(branch)}`);
  if (checkout.exitCode !== 0) {
    return { ok: false, branch, detail: checkout.stderr || checkout.stdout };
  }
  return { ok: true, branch, detail: `on ${branch} from ${base}` };
}

/** Commits made on this branch since it diverged from the base. */
export async function commitsOnBranch(cwd: string, base: string): Promise<string[]> {
  const res = await shell(cwd, `git log --format=%h --no-merges origin/${base}..HEAD 2>/dev/null`);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const res = await shell(cwd, `git diff --name-only origin/${base}...HEAD 2>/dev/null`);
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
