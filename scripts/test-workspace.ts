import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, restoreWorkspace, prepareRepo } from "@kapi/agent-core";
import { test, equal, assert, report } from "./harness.ts";
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "kapi-workspace-test-"));
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }
try {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "test"); await git(root, "config", "user.email", "test@test.local");
  await writeFile(join(root, "file.txt"), "base\n"); await git(root, "add", "."); await git(root, "commit", "-m", "base");
  const first = await mkdtemp(join(tmpdir(), "kapi-first-"));
  const second = await mkdtemp(join(tmpdir(), "kapi-second-"));
  try {
    for (const cwd of [first, second]) assert((await prepareRepo({ cwd, jobId: "job_test", log: () => {} }, null, { repoUrl: root })).ok, "clone works");
    await writeFile(join(first, "file.txt"), "committed\n"); await git(first, "add", "."); await git(first, "commit", "-m", "local-only");
    await writeFile(join(first, "file.txt"), "staged\n"); await git(first, "add", ".");
    await writeFile(join(first, "file.txt"), "unstaged\n");
    await writeFile(join(first, "binary.bin"), Buffer.from([0, 1, 255, 42])); await chmod(join(first, "binary.bin"), 0o755);
    const snapshot = await captureWorkspace(first, "main");
    await test("fresh VM restores unpublished commits, index, edits and binary untracked files", async () => {
      await restoreWorkspace(second, snapshot, "kapi/job_test");
      equal(await git(second, "rev-parse", "HEAD"), await git(first, "rev-parse", "HEAD"));
      equal(await git(second, "diff", "--cached"), await git(first, "diff", "--cached"));
      equal(await readFile(join(second, "file.txt"), "utf8"), "unstaged\n");
      equal((await readFile(join(second, "binary.bin"))).toString("hex"), "0001ff2a");
      equal(await git(second, "status", "--porcelain"), await git(first, "status", "--porcelain"));
    });
    await test("oversized workspace fails instead of saving a misleading checkpoint", async () => {
      await writeFile(join(first, "large.bin"), Buffer.alloc(64*1024*1024+1));
      let failed = false; try { await captureWorkspace(first, "main"); } catch { failed = true; }
      assert(failed, "snapshot must refuse oversized data");
    });
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
} finally { await rm(root, { recursive: true, force: true }); }
report();
