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
    private planeId = process.env.KAPI_PLANE_ID ?? "default",
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
      const owned = resources.filter((resource) => this.#isOwned(resource));
      const tracked = await this.handle.raw<{ job_id: string; run_id: string; vm_id: string; reservation_id:string|null; status:string; stopped_at:unknown; last_heartbeat:string }>(
        `SELECT job_id,run_id,vm_id,reservation_id,status,stopped_at,last_heartbeat FROM agents
         WHERE provider=$1 AND vm_id IS NOT NULL`, [this.provider.name],
      );
      const byId = new Map(tracked.map((a) => [a.vm_id, a]));
      const found = new Map(owned.map((r) => [r.id, r]));
      const matched=new Set<string>();
      for(const resource of owned){
        const reservation=tracked.find(a=>a.reservation_id&&a.vm_id===a.reservation_id&&
          resource.metadata?.reservationId===a.reservation_id&&resource.metadata?.jobId===a.job_id&&resource.metadata?.runId===a.run_id);
        if(!reservation)continue;
        matched.add(reservation.job_id);
        byId.set(resource.id,reservation);
        // Do not disturb a create call that is still within its startup window.
        const age=+now-new Date(reservation.last_heartbeat).getTime();
        if(reservation.status==="provisioning"&&!reservation.stopped_at&&age<Number(process.env.KAPI_PROVISION_TIMEOUT_SECONDS??120)*1000)continue;
        await this.handle.raw(`UPDATE agents SET vm_id=$2,status='provision-timeout',stopped_at=now()
          WHERE job_id=$1 AND reservation_id=$3 AND vm_id=$3`,[reservation.job_id,resource.id,reservation.reservation_id]);
        log("warn","vm.ambiguous_creation_recovered",{jobId:reservation.job_id,vmId:resource.id});
      }
      let orphaned = 0, destroyed = 0;
      for (const resource of owned) {
        if (byId.has(resource.id) || +now - resource.createdAt < this.graceMs) continue;
        orphaned++;
        log("warn", "vm.orphan_detected", { provider: this.provider.name, vmId: resource.id,
          auditOnly: this.auditOnly, jobId: resource.metadata?.jobId, runId: resource.metadata?.runId });
        if (!this.auditOnly) {
          const ok = await this.provider.destroyOrphan?.(resource.id).catch(() => false);
          if (ok) destroyed++;
        }
      }
      let missing = 0;
      for (const agent of tracked) {
        if(agent.reservation_id&&agent.vm_id===agent.reservation_id){
          if(matched.has(agent.job_id))continue;
          const age=+now-new Date(agent.last_heartbeat).getTime();
          // A healthy inventory after the grace window resolves an absent resource.
          // Late resources remain labelled and are subsequently reclaimed as orphans.
          if(age>=Math.max(this.graceMs,Number(process.env.KAPI_PROVISION_TIMEOUT_SECONDS??120)*1000))
            await this.handle.raw(`UPDATE agents SET vm_id=NULL,status='provision-absent',stopped_at=now() WHERE job_id=$1 AND vm_id=$2`,[agent.job_id,agent.vm_id]);
          continue;
        }
        if(agent.stopped_at)continue;
        const resource = found.get(agent.vm_id);
        const unhealthy = resource?.status != null &&
          /^(stopped|failed|error|destroyed|deleted|offline|exited|dead)$/i.test(resource.status);
        if (resource && !unhealthy) continue;
        missing++;
        await this.handle.raw(
          `UPDATE agents SET status=$2, stopped_at=now()
           WHERE job_id=$1 AND stopped_at IS NULL`,
          [agent.job_id, unhealthy ? "resource-stopped" : "resource-missing"],
        );
      }
      return { discovered: resources.length, orphaned, destroyed, missing };
    } finally { this.#busy = false; }
  }

  #isOwned(resource: ManagedVm): boolean {
    return resource.managed === true && resource.metadata?.planeId === this.planeId &&
      Boolean(resource.metadata?.jobId && resource.metadata?.runId);
  }
}
