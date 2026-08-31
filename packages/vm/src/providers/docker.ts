import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExecOptions, ExecResult, LogChunk, ManagedVm, Vm, VmProvider, VmSpec,
} from "../types.ts";
import { VmError } from "../types.ts";

const run = promisify(execFile);

/**
 * Container-per-agent on any Docker host - the permanently free deployment
 * target (an Oracle Always-Free ARM VM runs this happily).
 *
 * Real process/filesystem isolation without per-second billing.
 */
export class DockerProvider implements VmProvider {
  readonly name = "docker";
  #boxes = new Map<string, Vm>();

  constructor(private defaultImage = process.env.KAPI_AGENT_IMAGE ?? "kapi/agent:latest") {}

  async isAvailable() {
    try {
      await run("docker", ["info"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async create(spec: VmSpec): Promise<Vm> {
    const workdir = spec.workdir ?? "/workspace";
    const name = `kapi-${spec.name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40)}-${Date.now().toString(36)}`;
    const args = [
      "run", "-d", "--name", name,
      "--label", "kapi.managed=true",
      "--workdir", workdir,
      // Defence in depth: agents run untrusted generated code.
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "512",
    ];
    for (const [k, v] of Object.entries(spec.metadata ?? {})) {
      args.push("--label", `kapi.${k}=${v}`);
    }
    if (spec.cpus) args.push("--cpus", String(spec.cpus));
    if (spec.memoryMb) args.push("--memory", `${spec.memoryMb}m`);
    for (const [k, v] of Object.entries(spec.env ?? {})) args.push("-e", `${k}=${v}`);
    // Let the agent reach an orchestrator running on the host.
    args.push("--add-host", "host.docker.internal:host-gateway");
    args.push(spec.image ?? this.defaultImage, "sleep", "infinity");

    try {
      const { stdout } = await run("docker", args);
      const id = stdout.trim();
      await run("docker", ["exec", id, "mkdir", "-p", workdir]);
      const box: Vm = { id, provider: this.name, workdir, createdAt: Date.now(), metadata: spec.metadata };
      this.#boxes.set(id, box);
      return box;
    } catch (cause) {
      throw new VmError(`docker run failed: ${String(cause)}`, this.name, cause);
    }
  }

  #box(id: string): Vm {
    const box = this.#boxes.get(id);
    if (!box) throw new VmError(`unknown vm ${id}`, this.name);
    return box;
  }

  #execArgs(id: string, cmd: string, opts: ExecOptions): string[] {
    const box = this.#box(id);
    const args = ["exec", "-w", opts.cwd ?? box.workdir];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(id, "bash", "-lc", cmd);
    return args;
  }

  async exec(id: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    try {
      const { stdout, stderr } = await run("docker", this.#execArgs(id, cmd, opts), {
        timeout: opts.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started };
    } catch (err: any) {
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  async *execStream(id: string, cmd: string, opts: ExecOptions = {}): AsyncIterable<LogChunk> {
    const child = spawn("docker", this.#execArgs(id, cmd, opts), { stdio: ["ignore", "pipe", "pipe"] });
    const queue: LogChunk[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const push = (c: LogChunk) => { queue.push(c); wake?.(); wake = null; };

    child.stdout.on("data", (d) => push({ stream: "stdout", data: d.toString() }));
    child.stderr.on("data", (d) => push({ stream: "stderr", data: d.toString() }));
    child.on("close", () => { done = true; wake?.(); wake = null; });

    while (!done || queue.length > 0) {
      if (queue.length === 0) { await new Promise<void>((r) => (wake = r)); continue; }
      yield queue.shift()!;
    }
  }

  /** Fire-and-forget, via `docker exec -d`. */
  async spawnDetached(id: string, cmd: string, opts: ExecOptions = {}) {
    const box = this.#box(id);
    const args = ["exec", "-d", "-w", opts.cwd ?? box.workdir];
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(id, "bash", "-lc", cmd);
    await run("docker", args, { timeout: 30_000 });
  }

  async writeFile(id: string, path: string, content: string) {
    const box = this.#box(id);
    const abs = path.startsWith("/") ? path : `${box.workdir}/${path}`;
    // Base64 round-trip: avoids heredoc delimiter collisions and shell-quoting
    // hazards in arbitrary file content.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const res = await this.exec(
      id,
      `mkdir -p "$(dirname '${abs}')" && printf %s '${b64}' | base64 -d > '${abs}'`,
    );
    if (res.exitCode !== 0) {
      throw new VmError(`writeFile failed: ${res.stderr}`, this.name);
    }
  }

  async readFile(id: string, path: string) {
    const box = this.#box(id);
    const abs = path.startsWith("/") ? path : `${box.workdir}/${path}`;
    const res = await this.exec(id, `cat '${abs}'`);
    if (res.exitCode !== 0) throw new VmError(`readFile failed: ${res.stderr}`, this.name);
    return res.stdout;
  }

  async destroy(id: string) {
    if (!this.#boxes.has(id)) return;
    try {
      await run("docker", ["rm", "-f", id], { timeout: 30000 });
    } finally {
      this.#boxes.delete(id);
    }
  }

  /** Containers are addressable by id, so a restarted plane can still clean up. */
  async destroyOrphan(id: string) {
    try {
      await run("docker", ["rm", "-f", id], { timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listManaged(): Promise<ManagedVm[]> {
    const { stdout } = await run("docker", ["ps", "-aq", "--filter", "label=kapi.managed=true"]);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await run("docker", ["inspect", ...ids]);
    const rows = JSON.parse(inspected.stdout) as Array<any>;
    return rows
      .filter((r) => r.Config?.Labels?.["kapi.managed"] === "true")
      .map((r) => {
        const labels = r.Config.Labels as Record<string, string>;
        const metadata = Object.fromEntries(
          Object.entries(labels).filter(([k]) => k.startsWith("kapi.") && k !== "kapi.managed")
            .map(([k, v]) => [k.slice(5), v]),
        );
        return {
          id: r.Id, provider: this.name, workdir: "/workspace",
          createdAt: Date.parse(r.Created), metadata, managed: true as const,
          name: String(r.Name ?? "").replace(/^\//, ""), status: r.State?.Status,
        };
      });
  }

  async destroyAll() {
    await Promise.all([...this.#boxes.keys()].map((id) => this.destroy(id)));
  }
}
