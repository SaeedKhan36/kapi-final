import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DbHandle } from "@kapi/db";
import { mintJobToken } from "@kapi/identity";
import { AGENT_ENV, newId, type Job } from "@kapi/protocol";
import { toJob, type JobRow } from "@kapi/queue";
import { JOB_COLUMNS } from "@kapi/queue";
import { createVmProvider, type ProviderName, type VmProvider } from "@kapi/vm";

const AGENT_BUNDLE = fileURLToPath(
  new URL("../../agent/dist/agent.mjs", import.meta.url),
);

export type ProvisionerOptions = {
  provider?: VmProvider;
  intervalMs?: number;
  /** Where the agent dials back to. Must be reachable FROM the VM. */
  publicUrl?: string;
  /**
   * Only provision jobs for this run.
   *
   * The CLI drives a single run against a shared database, and without this it
   * would happily start VMs for every queued job anyone left behind.
   */
  runId?: string;
  onLog?: (line: string) => void;
};

/**
 * Gives queued work a VM to run on.
 *
 * The architecture is pull-based - VMs claim, nothing is pushed to them - but
 * a VM has to exist before it can pull. So this creates one per queued job and
 * points it at that job. The agent still claims through the ordinary lease, so
 * heartbeats, eviction and the reaper all behave exactly as they would for a
 * pooled worker; provisioning targets the job, it does not bypass the queue.
 */
export class Provisioner {
  #provider: VmProvider;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  /** jobId -> vmId, so a crash-free shutdown can clean up after itself. */
  #started = new Map<string, string>();
  #bundle: string | null = null;

  constructor(private handle: DbHandle, private opts: ProvisionerOptions = {}) {
    this.#provider = opts.provider ?? createVmProvider();
  }

  get providerName() { return this.#provider.name; }

  #log(line: string) {
    (this.opts.onLog ?? ((l: string) => console.log(l)))(`[provisioner] ${line}`);
  }

  start(): () => void {
    const interval = this.opts.intervalMs ?? 2000;
    this.#timer = setInterval(() => void this.tick(), interval);
    this.#timer.unref?.();
    return () => this.stop();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One pass. Exposed so tests can drive it deterministically. */
  async tick(): Promise<Job[]> {
    if (this.#busy) return [];
    this.#busy = true;
    try {
      const pending = await this.#pending();
      const started: Job[] = [];
      for (const job of pending) {
        try {
          await this.provision(job);
          started.push(job);
        } catch (err) {
          this.#log(`could not provision ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return started;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Queued jobs with no live agent, under their run's concurrency budget.
   *
   * The budget is a per-run cap on VMs alive at once. It is the only thing
   * limiting how wide a captain can fan out, and it is applied here rather than
   * at spawn time so that a captain is never told "no" for work it can
   * legitimately queue and wait for.
   *
   * Soft across processes: two planes running at once could each read the same
   * live count and jointly overshoot. The per-job insert below still prevents
   * two VMs for one job, which is the part that must never happen; the cap is a
   * spend guard, and briefly exceeding it costs money rather than correctness.
   */
  async #pending(limit = 20): Promise<Job[]> {
    const cols = JOB_COLUMNS.split(", ").join(", ");
    const rows = await this.handle.raw<JobRow>(
      `WITH live AS (
         SELECT run_id, count(*) AS n FROM agents WHERE stopped_at IS NULL GROUP BY run_id
       ),
       candidates AS (
         SELECT j.*,
                r.max_concurrent_vms,
                COALESCE(l.n, 0) AS live_count,
                ROW_NUMBER() OVER (
                  PARTITION BY j.run_id ORDER BY j.priority DESC, j.created_at ASC
                ) AS rn
         FROM jobs j
         JOIN runs r ON r.id = j.run_id
         LEFT JOIN live l ON l.run_id = j.run_id
         WHERE j.status = 'queued'
           AND ($2::text IS NULL OR j.run_id = $2::text)
           AND r.status NOT IN ('cancelled','failed','completed')
           AND NOT EXISTS (
             SELECT 1 FROM agents a WHERE a.job_id = j.id AND a.stopped_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM jobs d WHERE d.id = ANY(j.depends_on) AND d.status <> 'succeeded'
           )
       )
       SELECT ${cols} FROM candidates
       -- rn is this job's position in its run's queue, so live_count + rn is
       -- how many VMs the run would have once this one starts. Counting live
       -- agents alone would let every job in one batch see the same zero and
       -- blow straight through the cap.
       WHERE live_count + rn <= max_concurrent_vms
       ORDER BY priority DESC, created_at ASC
       LIMIT $1`,
      [limit, this.opts.runId ?? null],
    );
    return rows.map(toJob);
  }

  async #agentBundle(): Promise<string> {
    if (this.#bundle) return this.#bundle;
    try {
      this.#bundle = await readFile(AGENT_BUNDLE, "utf8");
    } catch {
      throw new Error(
        `the agent bundle is missing at ${AGENT_BUNDLE}.\n` +
        `  Build it with: pnpm build:agent`,
      );
    }
    return this.#bundle;
  }

  #publicUrl(): string {
    const url =
      this.opts.publicUrl ??
      process.env.CONTROL_PLANE_PUBLIC_URL ??
      `http://localhost:${process.env.CONTROL_PLANE_PORT ?? 8787}`;

    // A cloud VM cannot reach your laptop. Failing here with the reason beats a
    // VM that starts, cannot dial home, and dies silently at its idle timeout.
    if (this.#provider.name === "daytona" && /localhost|127\.0\.0\.1/.test(url)) {
      throw new Error(
        `CONTROL_PLANE_PUBLIC_URL is "${url}", which a Daytona VM cannot reach.\n` +
        `  Expose the control plane (e.g. a tunnel) and set CONTROL_PLANE_PUBLIC_URL to that address.`,
      );
    }
    return url;
  }

  /** Creates the VM, installs the agent, and starts it. */
  async provision(job: Job): Promise<string> {
    const url = this.#publicUrl();
    const bundle = await this.#agentBundle();
    const vmId = newId("vm");

    // Claim the slot BEFORE creating anything: two provisioner ticks (or two
    // plane instances) must not both build a VM for the same job.
    const claimed = await this.handle.raw<{ job_id: string }>(
      `INSERT INTO agents (job_id, run_id, role, status, vm_id, last_heartbeat)
       VALUES ($1, $2, $3, 'provisioning', $4, now())
       ON CONFLICT (job_id) DO UPDATE
         SET status = 'provisioning', vm_id = EXCLUDED.vm_id,
             stopped_at = NULL, last_heartbeat = now()
         WHERE agents.stopped_at IS NOT NULL
       RETURNING job_id`,
      [job.id, job.runId, job.role, vmId],
    );
    if (claimed.length === 0) throw new Error("another provisioner already has this job");

    const idleTtl = job.payload.vmSpec?.idleTtlSeconds
      ?? Number(process.env.VM_IDLE_TTL_SECONDS ?? 900);

    let vm;
    try {
      vm = await this.#provider.create({
        name: `kapi-${job.id}`,
        image: job.payload.vmSpec?.image,
        cpus: job.payload.vmSpec?.cpus,
        memoryMb: job.payload.vmSpec?.memoryMb,
        // Always set. If the plane dies between here and the agent starting,
        // this timer is the only thing that stops the VM billing forever.
        idleTtlSeconds: idleTtl,
        env: {
          [AGENT_ENV.url]: url,
          [AGENT_ENV.jobId]: job.id,
          [AGENT_ENV.runId]: job.runId,
          [AGENT_ENV.vmId]: vmId,
          [AGENT_ENV.role]: job.role,
        },
      });
    } catch (err) {
      await this.#release(job.id, "provision-failed");
      throw err;
    }

    try {
      await this.#provider.writeFile(vm.id, `${vm.workdir}/agent.mjs`, bundle);

      const token = mintJobToken({ jobId: job.id, runId: job.runId, vmId });
      await this.#provider.spawnDetached(vm.id, "node agent.mjs", {
        cwd: vm.workdir,
        env: {
          [AGENT_ENV.url]: url,
          [AGENT_ENV.token]: token,
          [AGENT_ENV.jobId]: job.id,
          [AGENT_ENV.runId]: job.runId,
          [AGENT_ENV.vmId]: vmId,
          [AGENT_ENV.role]: job.role,
          [AGENT_ENV.workdir]: vm.workdir,
        },
      });
    } catch (err) {
      // Never leave a VM running for an agent that failed to start.
      await this.#provider.destroy(vm.id).catch(() => {});
      await this.#release(job.id, "agent-start-failed");
      throw err;
    }

    // The provider's id, not ours: destroy() and readFile() address it that way.
    await this.handle.raw(
      `UPDATE agents SET vm_id = $2 WHERE job_id = $1`, [job.id, vm.id],
    );
    this.#started.set(job.id, vm.id);
    this.#log(`${job.kind}/${job.role} ${job.id} -> ${this.#provider.name} vm ${vm.id}`);
    return vm.id;
  }

  async #release(jobId: string, status: string) {
    await this.handle.raw(
      `UPDATE agents SET status = $2, stopped_at = now() WHERE job_id = $1`, [jobId, status],
    );
  }

  /** Destroys VMs for jobs that have reached a terminal state. */
  async reclaim(): Promise<number> {
    const rows = await this.handle.raw<{ job_id: string; vm_id: string }>(
      `SELECT a.job_id, a.vm_id FROM agents a
       JOIN jobs j ON j.id = a.job_id
       WHERE a.vm_id IS NOT NULL AND a.stopped_at IS NOT NULL
         AND j.status IN ('succeeded','failed','cancelled')`,
    );
    let destroyed = 0;
    for (const row of rows) {
      const ok = await this.#provider.destroy(row.vm_id).then(() => true).catch(() => false);
      // A VM this process did not create has no cached handle; providers that
      // can address one by id reattach rather than leaking it.
      const orphan = ok ? false : await this.#provider.destroyOrphan?.(row.vm_id).catch(() => false);
      if (ok || orphan) destroyed++;
      await this.handle.raw(`UPDATE agents SET vm_id = NULL WHERE job_id = $1`, [row.job_id]);
      this.#started.delete(row.job_id);
    }
    return destroyed;
  }

  async destroyAll() {
    await this.#provider.destroyAll?.();
    this.#started.clear();
  }
}

export const providerNameFromEnv = (): ProviderName =>
  (process.env.VM_PROVIDER as ProviderName) ?? "local";
