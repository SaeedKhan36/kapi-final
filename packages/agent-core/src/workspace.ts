import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { WorkspaceSnapshot } from "@kapi/protocol";
import { insideRepo } from "./tools/fs.ts";

const exec = promisify(execFile);
// Large exports travel in chunks; total decoded snapshots remain bounded.
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
async function git(cwd: string, args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_WORKSPACE_BYTES * 2,
    timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;
}

/** A thin bundle preserves local commits; binary patches preserve both index and worktree. */
export async function captureWorkspace(cwd: string, baseBranch: string, pinnedBase?: string): Promise<WorkspaceSnapshot> {
  const baseCommit = pinnedBase ?? (await git(cwd, ["merge-base", "HEAD", `origin/${baseBranch}`])).trim();
  const headCommit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  let bundle: string | undefined;
  const temp = await mkdtemp(join(tmpdir(), "kapi-snapshot-"));
  try {
    if (headCommit !== baseCommit) {
      const path = join(temp, "commits.bundle");
      await git(cwd, ["bundle", "create", path, "HEAD", `^${baseCommit}`]);
      bundle = (await readFile(path)).toString("base64");
    }
    const stagedPatch = await git(cwd, ["diff", "--cached", "--binary", "--full-index"]);
    const workingPatch = await git(cwd, ["diff", "--binary", "--full-index"]);
    const paths = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const untracked = [];
    let bytes = Buffer.byteLength(JSON.stringify({ bundle, stagedPatch, workingPatch }));
    for (const path of paths) {
      const absolute = insideRepo({ cwd } as never, path);
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new Error(`cannot checkpoint non-file: ${path}`);
      if (stat.size + bytes > MAX_WORKSPACE_BYTES) throw new Error("workspace exceeds checkpoint limit; publish or reduce output before continuing");
      const data = (await readFile(absolute)).toString("base64");
      untracked.push({ path, data, executable: Boolean(stat.mode & 0o111) });
      bytes += Buffer.byteLength(JSON.stringify(untracked.at(-1)));
    }
    const publishedHead = await git(cwd, ["config", "--get", "kapi.published-head"]).catch(() => "");
    const publication = publishedHead.trim() === headCommit && !stagedPatch && !workingPatch && !untracked.length
      ? "published" as const : "local" as const;
    const snapshot = { publication, baseCommit, headCommit, bundle, stagedPatch, workingPatch, untracked };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_WORKSPACE_BYTES) throw new Error("workspace exceeds checkpoint limit");
    return snapshot;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Called in a fresh checkout, before its matching transcript is resumed. */
export async function restoreWorkspace(cwd: string, snapshot: WorkspaceSnapshot, branch: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "kapi-restore-"));
  try {
    try { await git(cwd, ["cat-file", "-e", snapshot.baseCommit]); }
    catch { await git(cwd, ["fetch", "origin", snapshot.baseCommit]); }
    if (snapshot.bundle) {
      const path = join(temp, "commits.bundle");
      await writeFile(path, Buffer.from(snapshot.bundle, "base64"));
      await git(cwd, ["bundle", "verify", path]);
      await git(cwd, ["fetch", path, "HEAD"]);
    }
    await git(cwd, ["checkout", "-B", branch, snapshot.headCommit]);
    if (snapshot.publication === "published") await git(cwd, ["config", "--local", "kapi.published-head", snapshot.headCommit]);
    for (const [name, patch, index] of [["staged", snapshot.stagedPatch, true], ["working", snapshot.workingPatch, false]] as const) {
      if (!patch) continue;
      const path = join(temp, `${name}.patch`);
      await writeFile(path, patch);
      await git(cwd, ["apply", ...(index ? ["--index"] : []), "--binary", path]);
    }
    for (const file of snapshot.untracked) {
      const path = insideRepo({ cwd } as never, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.data, "base64"), { flag: "wx" });
      if (file.executable) await chmod(path, 0o755);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
