import type { DbHandle } from "@kapi/db";
import type { ManagedVm, VmProvider } from "@kapi/vm";
import { log } from "./log.ts";

export type ReconcileResult = { discovered: number; orphaned: number; destroyed: number; missing: number };

/** Provider inventory is authoritative only for resources carrying kapi.managed=true. */
export class VmReconciler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  readonly auditOnly: boolean;

  constructor(
    private handle: DbHandle,
    private provider: VmProvider,
    private intervalMs = Number(process.env.KAPI_RECONCILE_INTERVAL_MS ?? 60_000),
    private graceMs = Number(process.env.KAPI_ORPHAN_GRACE_SECONDS ?? 600) * 1000,
    auditOnly = process.env.KAPI_RECONCILE_DELETE !== "true",
  ) { this.auditOnly = auditOnly; }

  start(): () => void {
    this.#timer = setInterval(() => void this.reconcile().catch((err) => {
      console.error("[reconciler] pass failed", err);
    }), this.intervalMs);
    this.#timer.unref?.();
    void this.reconcile().catch(() => {});
    return () => this.stop();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  async reconcile(now = new Date()): Promise<ReconcileResult> {
    if (this.#busy || !this.provider.listManaged) return { discovered: 0, orphaned: 0, destroyed: 0, missing: 0 };
    this.#busy = true;
    try {
      const resources = await this.provider.listManaged();
      const active = await this.handle.raw<{ job_id: string; run_id: string; vm_id: string }>(
        `SELECT job_id,run_id,vm_id FROM agents
         WHERE provider=$1 AND vm_id IS NOT NULL AND stopped_at IS NULL`, [this.provider.name],
      );
      const byId = new Map(active.map((a) => [a.vm_id, a]));
      const found = new Set(resources.map((r) => r.id));
      let orphaned = 0, destroyed = 0;
      for (const resource of resources) {
        if (!this.#isOwned(resource) || byId.has(resource.id) || +now - resource.createdAt < this.graceMs) continue;
        orphaned++;
        log("warn", "vm.orphan_detected", { provider: this.provider.name, vmId: resource.id,
          auditOnly: this.auditOnly, jobId: resource.metadata?.jobId, runId: resource.metadata?.runId });
        if (!this.auditOnly) {
          const ok = await this.provider.destroyOrphan?.(resource.id).catch(() => false);
          if (ok) destroyed++;
        }
      }
      let missing = 0;
      for (const agent of active) {
        if (found.has(agent.vm_id)) continue;
        missing++;
        await this.handle.raw(
          `UPDATE agents SET status='resource-missing', stopped_at=now()
           WHERE job_id=$1 AND stopped_at IS NULL`, [agent.job_id],
        );
      }
      return { discovered: resources.length, orphaned, destroyed, missing };
    } finally { this.#busy = false; }
  }

  #isOwned(resource: ManagedVm): boolean {
    return resource.managed === true && Boolean(resource.metadata?.jobId && resource.metadata?.runId);
  }
}
