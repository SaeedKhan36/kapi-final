import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import type {
  ExecOptions, ExecResult, LogChunk, Vm, VmProvider, VmSpec,
} from "../types.ts";
import { VmError } from "../types.ts";

/**
 * Runs agents as local subprocesses in an isolated temp directory.
 *
 * This is the fast development loop: no Docker daemon, no cloud account, no
 * cold start. It gives filesystem separation (each agent gets its own clone and
 * its own branch) but NOT security isolation - the process can reach the host.
 * Use it for developing orchestration logic; use Daytona or Docker whenever the
 * agent is running code we did not write.
 */
export class LocalProvider implements VmProvider {
  readonly name = "local";
  #boxes = new Map<string, Vm>();
  /** VM-scoped env from VmSpec, merged into every exec. */
  #env = new Map<string, Record<string, string>>();
  /** PIDs started by spawnDetached, so destroy() does not leave them running. */
  #detached = new Map<string, number[]>();

  async isAvailable() {
    return true;
  }

  async create(spec: VmSpec): Promise<Vm> {
    const safe = spec.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48);
    const root = await mkdtemp(join(tmpdir(), `kapi-${safe}-`));
    const workdir = join(root, "workspace");
    await mkdir(workdir, { recursive: true });

    const box: Vm = { id: root, provider: this.name, workdir, createdAt: Date.now() };
    this.#boxes.set(root, box);
    this.#env.set(root, spec.env ?? {});
    return box;
  }

  #box(id: string): Vm {
    const box = this.#boxes.get(id);
    if (!box) throw new VmError(`unknown vm ${id}`, this.name);
    return box;
  }

  /** Reject paths that escape the sandbox root via `..` or absolute paths. */
  #resolveInside(box: Vm, path: string): string {
    const target = isAbsolute(path) ? path : resolve(box.workdir, path);
    const rel = relative(box.workdir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new VmError(`path escapes the vm workdir: ${path}`, this.name);
    }
    return target;
  }

  /**
   * Spawns directly rather than draining execStream: sharing exit-code state
   * between the two would race whenever two commands run concurrently in one sandbox.
   */
  async exec(id: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const box = this.#box(id);
    const cwd = opts.cwd ? this.#resolveInside(box, opts.cwd) : box.workdir;
    const started = Date.now();

    return new Promise<ExecResult>((resolveExec) => {
      const child = spawn("bash", ["-lc", cmd], {
        cwd,
        env: { ...process.env, ...this.#env.get(id), ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveExec({ exitCode, stdout, stderr, durationMs: Date.now() - started });
      };

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            stderr += `\n[kapi] command exceeded ${opts.timeoutMs}ms, killed\n`;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        stderr += String(err);
        finish(127);
      });
      child.on("close", (code) => finish(code ?? 0));
    });
  }

  async *execStream(id: string, cmd: string, opts: ExecOptions = {}): AsyncIterable<LogChunk> {
    const box = this.#box(id);
    const cwd = opts.cwd ? this.#resolveInside(box, opts.cwd) : box.workdir;

    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: { ...process.env, ...this.#env.get(id), ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const queue: LogChunk[] = [];
    let done = false;
    let exitCode = 0;
    let wake: (() => void) | null = null;
    const push = (chunk: LogChunk) => {
      queue.push(chunk);
      wake?.();
      wake = null;
    };

    child.stdout.on("data", (d) => push({ stream: "stdout", data: d.toString() }));
    child.stderr.on("data", (d) => push({ stream: "stderr", data: d.toString() }));

    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;

    child.on("close", (code) => {
      exitCode = code ?? 0;
      done = true;
      wake?.();
      wake = null;
    });
    child.on("error", (err) => {
      push({ stream: "stderr", data: String(err) });
      exitCode = 127;
      done = true;
      wake?.();
      wake = null;
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield queue.shift()!;
      }
      if (exitCode !== 0) {
        yield { stream: "stderr", data: `\n[kapi] exited with code ${exitCode}\n` };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fire-and-forget. The agent runs for the whole life of its job, so the
   * provisioner must not wait on it - it hands the process off and returns.
   */
  async spawnDetached(id: string, cmd: string, opts: ExecOptions = {}) {
    const box = this.#box(id);
    const cwd = opts.cwd ? this.#resolveInside(box, opts.cwd) : box.workdir;
    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: { ...process.env, ...this.#env.get(id), ...opts.env },
      stdio: "ignore",
      detached: true,
    });
    this.#detached.set(id, [...(this.#detached.get(id) ?? []), child.pid ?? 0]);
    child.unref();
  }

  async writeFile(id: string, path: string, content: string) {
    const target = this.#resolveInside(this.#box(id), path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async readFile(id: string, path: string) {
    return readFile(this.#resolveInside(this.#box(id), path), "utf8");
  }

  async destroy(id: string) {
    const box = this.#boxes.get(id);
    if (!box) return;
    // Detached children outlive their parent by design, so removing the
    // directory without killing them leaves orphaned agents polling forever.
    for (const pid of this.#detached.get(id) ?? []) {
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    this.#detached.delete(id);
    await rm(box.id, { recursive: true, force: true });
    this.#boxes.delete(id);
    this.#env.delete(id);
  }

  async destroyAll() {
    await Promise.all([...this.#boxes.keys()].map((id) => this.destroy(id)));
  }
}
