import type {
  ExecOptions, ExecResult, LogChunk, Vm, VmProvider, VmSpec,
} from "../types.ts";
import { VmError } from "../types.ts";

/**
 * Daytona Cloud - real isolation, ~90ms starts.
 *
 * NOTE ON COST: Daytona is billed per second (~$0.08/hr for 1 vCPU / 2GiB) with
 * $200 of trial credit, not a perpetual free tier. Idle sandboxes quietly burn
 * that credit, so `idleTtlSeconds` is always set and `destroy` is called in a
 * finally block by callers.
 *
 * This file is the ONLY place the Daytona SDK may be imported.
 */
export class DaytonaProvider implements VmProvider {
  readonly name = "daytona";
  #client: any = null;
  #boxes = new Map<string, { handle: any; box: Vm }>();

  constructor(
    private apiKey = process.env.DAYTONA_API_KEY,
    private apiUrl = process.env.DAYTONA_API_URL,
  ) {}

  async isAvailable() {
    if (!this.apiKey) return false;
    try {
      await import("@daytonaio/sdk");
      return true;
    } catch {
      return false;
    }
  }

  async #sdk() {
    if (this.#client) return this.#client;
    if (!this.apiKey) throw new VmError("DAYTONA_API_KEY is not set", this.name);
    let mod: any;
    try {
      mod = await import("@daytonaio/sdk");
    } catch (cause) {
      throw new VmError(
        "@daytonaio/sdk is not installed - run: pnpm add -w @daytonaio/sdk",
        this.name,
        cause,
      );
    }
    const Daytona = mod.Daytona ?? mod.default?.Daytona;
    this.#client = new Daytona({
      apiKey: this.apiKey,
      ...(this.apiUrl ? { apiUrl: this.apiUrl } : {}),
    });
    return this.#client;
  }

  async create(spec: VmSpec): Promise<Vm> {
    const daytona = await this.#sdk();
    try {
      // Daytona rejects explicit resources when the sandbox comes from a
      // snapshot (the default path), so only send them alongside a custom image.
      const resources = spec.image
        ? { resources: { cpu: spec.cpus ?? 1, memory: Math.round((spec.memoryMb ?? 2048) / 1024) } }
        : {};

      const handle = await daytona.create({
        language: "typescript",
        ...(spec.image ? { image: spec.image } : {}),
        envVars: spec.env,
        autoStopInterval: Math.max(1, Math.round((spec.idleTtlSeconds ?? 900) / 60)),
        ...resources,
      });
      const id = handle.id ?? handle.vmId;
      const workdir = spec.workdir ?? "/home/daytona/workspace";

      // Create the workdir BEFORE registering the sandbox: exec() resolves a
      // missing cwd against the workdir, so bootstrapping it through exec would
      // ask the runner to chdir into the very directory it is creating.
      const made = await handle.process.executeCommand(`mkdir -p ${workdir}`);
      if ((made.exitCode ?? 0) !== 0) {
        throw new VmError(`could not create workdir ${workdir}: ${made.result ?? ""}`, this.name);
      }

      const box: Vm = { id, provider: this.name, workdir, createdAt: Date.now() };
      this.#boxes.set(id, { handle, box });
      return box;
    } catch (cause) {
      throw new VmError(`failed to create vm: ${String(cause)}`, this.name, cause);
    }
  }

  #handle(id: string) {
    const entry = this.#boxes.get(id);
    if (!entry) throw new VmError(`unknown vm ${id}`, this.name);
    return entry;
  }

  /** Resolves a possibly-relative cwd against the sandbox workdir. */
  #resolveCwd(box: Vm, cwd?: string): string {
    if (!cwd) return box.workdir;
    return cwd.startsWith("/") ? cwd : `${box.workdir}/${cwd}`;
  }

  async exec(id: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const { handle, box } = this.#handle(id);
    const started = Date.now();
    // Daytona requires an ABSOLUTE cwd; a relative one fails with a confusing
    // shell error rather than a path error.
    const cwd = this.#resolveCwd(box, opts.cwd);

    const res = await handle.process.executeCommand(
      cmd,
      cwd,
      opts.env,
      opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined,
    );

    const output = res.result ?? res.stdout ?? "";
    return {
      exitCode: res.exitCode ?? 0,
      // Daytona merges streams into `result`; attribute it to stdout on success
      // and stderr on failure so callers reading either still see the message.
      stdout: output,
      stderr: (res.exitCode ?? 0) === 0 ? (res.stderr ?? "") : output,
      durationMs: Date.now() - started,
    };
  }

  /** Daytona's exec is request/response; emit the buffered result as one chunk. */
  async *execStream(id: string, cmd: string, opts: ExecOptions = {}): AsyncIterable<LogChunk> {
    const res = await this.exec(id, cmd, opts);
    if (res.stdout) yield { stream: "stdout", data: res.stdout };
    if (res.stderr) yield { stream: "stderr", data: res.stderr };
  }

  /**
   * Fire-and-forget. Daytona's exec is request/response and would block for the
   * agent's entire lifetime, so the command is backgrounded inside the VM with
   * nohup and its output redirected to a file the plane can read back.
   */
  async spawnDetached(id: string, cmd: string, opts: ExecOptions = {}) {
    const { box } = this.#handle(id);
    const cwd = this.#resolveCwd(box, opts.cwd);
    const env = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
      .join(" ");
    const res = await this.exec(
      id,
      `${env} nohup ${cmd} > ${cwd}/agent.log 2>&1 < /dev/null & echo $!`,
      { cwd, timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0) {
      throw new VmError(`could not start detached process: ${res.stderr || res.stdout}`, this.name);
    }
  }

  async writeFile(id: string, path: string, content: string) {
    const { handle, box } = this.#handle(id);
    const abs = this.#resolveCwd(box, path);
    const buf = Buffer.from(content, "utf8");
    if (handle.fs?.uploadFile) await handle.fs.uploadFile(buf, abs);
    else await this.exec(id, `mkdir -p "$(dirname ${abs})" && cat > ${abs} <<'KAPI_EOF'\n${content}\nKAPI_EOF`);
  }

  async readFile(id: string, path: string) {
    const { handle, box } = this.#handle(id);
    const abs = this.#resolveCwd(box, path);
    if (handle.fs?.downloadFile) {
      const buf = await handle.fs.downloadFile(abs);
      return Buffer.from(buf).toString("utf8");
    }
    return (await this.exec(id, `cat ${abs}`)).stdout;
  }

  async destroy(id: string) {
    const entry = this.#boxes.get(id);
    if (!entry) return;
    try {
      await (entry.handle.delete?.() ?? entry.handle.remove?.());
    } finally {
      this.#boxes.delete(id);
    }
  }

  /**
   * Deletes a VM this process never created.
   *
   * The control plane keeps its handles in memory, so a restart loses track of
   * every running VM while Daytona keeps billing for them. Sandboxes are
   * addressable by id, so reattaching is the difference between a restart
   * costing nothing and leaking every VM that was live at the time.
   */
  async destroyOrphan(id: string) {
    try {
      const daytona = await this.#sdk();
      const handle = await (daytona.get?.(id) ?? daytona.findOne?.({ id }));
      if (!handle) return false;
      await (handle.delete?.() ?? handle.remove?.());
      this.#boxes.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  async destroyAll() {
    await Promise.all([...this.#boxes.keys()].map((id) => this.destroy(id)));
  }
}
