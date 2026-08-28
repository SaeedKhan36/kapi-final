/**
 * The isolation boundary for one agent.
 *
 * Nothing outside providers/ may import a vendor SDK. Swapping Daytona for
 * self-hosted Docker (or anything else) must be a one-line config change.
 */
export type VmSpec = {
  /** Stable label, e.g. "kapi-<jobId>". Providers may sanitise it. */
  name: string;
  image?: string;
  env?: Record<string, string>;
  /** Absolute path inside the VM where work happens. */
  workdir?: string;
  cpus?: number;
  memoryMb?: number;
  /**
   * Auto-destroy after this many idle seconds.
   *
   * Always set. A captain may spawn dozens of VMs and the control plane can
   * restart without its in-memory handles, so the provider-side idle timer is
   * the only backstop that survives losing track of a VM entirely.
   */
  idleTtlSeconds?: number;
};

export type Vm = {
  id: string;
  provider: string;
  workdir: string;
  createdAt: number;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type LogChunk = { stream: "stdout" | "stderr"; data: string };

export interface VmProvider {
  readonly name: string;
  /** True when the provider's prerequisites (binary, API key) are present. */
  isAvailable(): Promise<boolean>;
  create(spec: VmSpec): Promise<Vm>;
  exec(id: string, cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  execStream(id: string, cmd: string, opts?: ExecOptions): AsyncIterable<LogChunk>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  /**
   * Starts a long-running process and returns immediately.
   *
   * This is what the agent bootstrap needs and `exec` cannot give: the agent
   * runs for the life of the job, so waiting for it to exit would block the
   * provisioner forever.
   */
  spawnDetached(id: string, cmd: string, opts?: ExecOptions): Promise<void>;
  destroy(id: string): Promise<void>;
  /**
   * Destroys by id without a cached handle, for a VM this process did not
   * create - the case after a control-plane restart. Returns false when the
   * provider cannot reattach.
   */
  destroyOrphan?(id: string): Promise<boolean>;
  /** Best-effort cleanup of anything this process leaked. */
  destroyAll?(): Promise<void>;
}

export class VmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VmError";
  }
}
