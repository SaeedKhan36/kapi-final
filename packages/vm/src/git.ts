import type { VmProvider } from "./types.ts";
import { VmError } from "./types.ts";

export type GitIdentity = { name: string; email: string };

/** Dependency and build directories no agent should ever commit. */
export const DEFAULT_EXCLUDES = [
  "# Written by kapi. Agents commit with `git add -A`; these must never land.",
  "node_modules/", "bower_components/", "vendor/",
  "dist/", "build/", "out/", ".next/", ".nuxt/", ".output/", ".svelte-kit/",
  "target/", "__pycache__/", "*.pyc", ".venv/", "venv/", ".tox/",
  "coverage/", ".nyc_output/", ".turbo/", ".cache/", ".parcel-cache/",
  "*.log", ".DS_Store", ".env", ".env.local",
  "",
].join("\n");

/** Injects a token into an https remote without ever logging it. */
export function authenticatedRemote(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") return repoUrl;
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

export const redact = (text: string, ...secrets: Array<string | undefined>): string =>
  secrets
    .filter((s): s is string => typeof s === "string" && s.length > 6)
    .reduce((acc, s) => acc.split(s).join("***"), text);

/**
 * Shallow-clones a repo into a sandbox and configures identity.
 * `depth` keeps clones fast; the Captain only ever needs a read-only view.
 */
export async function cloneRepo(
  provider: VmProvider,
  vmId: string,
  opts: {
    repoUrl: string;
    branch?: string;
    token?: string;
    identity?: GitIdentity;
    depth?: number;
    dir?: string;
  },
) {
  const dir = opts.dir ?? ".";
  const remote = authenticatedRemote(opts.repoUrl, opts.token);
  // A freshly created repo has no branches at all, so --branch would fail.
  // Clone bare of that flag and check the branch out afterwards if it exists.
  const branchArg = opts.branch ? `--branch ${shellQuote(opts.branch)}` : "";
  const depthArg = opts.depth === 0 ? "" : `--depth ${opts.depth ?? 50}`;

  let res = await provider.exec(
    vmId,
    `git clone ${depthArg} ${branchArg} ${shellQuote(remote)} ${shellQuote(dir)} 2>&1`,
    { timeoutMs: 180_000 },
  );

  // Retry without --branch: an empty repo has no branch to ask for.
  if (res.exitCode !== 0 && branchArg) {
    res = await provider.exec(
      vmId,
      `rm -rf ${shellQuote(dir)} && git clone ${depthArg} ${shellQuote(remote)} ${shellQuote(dir)} 2>&1`,
      { timeoutMs: 180_000 },
    );
  }

  if (res.exitCode !== 0) {
    throw new VmError(
      `git clone failed: ${redact(res.stdout + res.stderr, opts.token)}`,
      provider.name,
    );
  }

  // Guard the repo against build artefacts BEFORE any agent touches it.
  // Agents commit with `git add -A`; without this, one `npm install` puts
  // thousands of node_modules files into the pull request. Written to
  // .git/info/exclude rather than .gitignore so it never shows up in the diff.
  await provider.writeFile(vmId, `${dir}/.git/info/exclude`, DEFAULT_EXCLUDES);

  const id = opts.identity ?? { name: "kapi-agent", email: "agent@kapi.local" };
  await provider.exec(
    vmId,
    [
      `git config user.name ${shellQuote(id.name)}`,
      `git config user.email ${shellQuote(id.email)}`,
      // Agents must never open an interactive editor or credential prompt.
      `git config core.editor true`,
      `git config advice.detachedHead false`,
    ].join(" && "),
    { cwd: dir === "." ? undefined : dir },
  );
}

/** True when the clone has no commits yet (a freshly created GitHub repo). */
export async function isEmptyRepo(
  provider: VmProvider, vmId: string, dir = "repo",
): Promise<boolean> {
  const res = await provider.exec(vmId, "git rev-parse --verify HEAD", { cwd: dir });
  return res.exitCode !== 0;
}

/**
 * Gives an empty repository a root commit on `branch` and pushes it.
 *
 * Without this, nothing downstream works: there is no HEAD to diff against, no
 * branch to cut from, and no base for a pull request to target. Only ever
 * called when the repo genuinely has zero commits, so it cannot clobber
 * existing history.
 */
export async function seedEmptyRepo(
  provider: VmProvider,
  vmId: string,
  opts: { branch: string; token?: string; dir?: string; readmeTitle?: string },
): Promise<void> {
  const dir = opts.dir ?? "repo";
  const title = opts.readmeTitle ?? "Project";

  await provider.writeFile(
    vmId,
    `${dir}/README.md`,
    `# ${title}\n\nInitialised by kapi so agents have a base branch to work from.\n`,
  );

  const res = await provider.exec(
    vmId,
    [
      `git checkout -b ${shellQuote(opts.branch)} 2>/dev/null || git checkout ${shellQuote(opts.branch)}`,
      "git add -A",
      `git commit -m ${shellQuote("Initialise repository")}`,
      `git push -u origin ${shellQuote(opts.branch)} 2>&1`,
    ].join(" && "),
    { cwd: dir, timeoutMs: 120_000 },
  );

  if (res.exitCode !== 0) {
    throw new VmError(
      `failed to seed empty repo: ${redact(res.stdout + res.stderr, opts.token)}`,
      provider.name,
    );
  }
}

export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Creates `branch` from `from` and pushes it, so later clones can start there.
 * Used to stand up the run's integration branch before any worker begins.
 */
export async function createRemoteBranch(
  provider: VmProvider,
  vmId: string,
  opts: { branch: string; from: string; token?: string; dir?: string },
): Promise<void> {
  const dir = opts.dir ?? "repo";
  const res = await provider.exec(
    vmId,
    [
      `git checkout ${shellQuote(opts.from)}`,
      `git checkout -B ${shellQuote(opts.branch)}`,
      `git push -u origin ${shellQuote(opts.branch)} 2>&1`,
    ].join(" && "),
    { cwd: dir, timeoutMs: 120_000 },
  );
  if (res.exitCode !== 0) {
    throw new VmError(
      `failed to create branch ${opts.branch}: ${redact(res.stdout + res.stderr, opts.token)}`,
      provider.name,
    );
  }
}

export type MergeResult = { ok: boolean; conflicted: boolean; detail: string };

/**
 * Merges a finished task branch into the integration branch and pushes it.
 *
 * This is what makes a dependency edge mean anything: without it every worker
 * clones the base branch and a dependant never sees the work it was waiting on.
 * Callers must serialise merges — concurrent pushes to one branch race.
 */
export async function mergeIntoIntegration(
  provider: VmProvider,
  vmId: string,
  opts: { integration: string; branch: string; token?: string; dir?: string },
): Promise<MergeResult> {
  const dir = opts.dir ?? "repo";
  const res = await provider.exec(
    vmId,
    [
      `git fetch origin ${shellQuote(opts.integration)} 2>&1`,
      `git checkout ${shellQuote(opts.integration)} 2>/dev/null || git checkout -b ${shellQuote(opts.integration)} origin/${opts.integration}`,
      `git reset --hard origin/${shellQuote(opts.integration)}`,
      `git merge --no-edit ${shellQuote(opts.branch)} 2>&1`,
      `git push origin ${shellQuote(opts.integration)} 2>&1`,
    ].join(" && "),
    { cwd: dir, timeoutMs: 180_000 },
  );

  const output = redact(res.stdout + res.stderr, opts.token);
  if (res.exitCode === 0) return { ok: true, conflicted: false, detail: output.slice(-400) };

  const conflicted = /CONFLICT|Automatic merge failed/i.test(output);
  // Leave the working tree clean so the sandbox can still be inspected.
  await provider.exec(vmId, "git merge --abort 2>/dev/null || true", { cwd: dir });
  return { ok: false, conflicted, detail: output.slice(-400) };
}

/**
 * Branch naming.
 *
 * Git stores refs as a directory tree, so `kapi/run-X` (a file) and
 * `kapi/run-X/my-task` (which needs `kapi/run-X` to be a directory) cannot both
 * exist. Keeping the integration ref and task refs on separate leaves of
 * `kapi/<runId>/` avoids that collision entirely.
 */
export const integrationBranch = (runId: string) => `kapi/${runId}/integration`;
export const taskBranch = (runId: string, taskId: string) => `kapi/${runId}/tasks/${taskId}`;
