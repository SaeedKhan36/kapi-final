import type { DbHandle } from "@kapi/db";
import { startReaper } from "@kapi/queue";
import type { EventHub } from "./events.ts";
import { Provisioner } from "./provisioner.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { RunService } from "./run-service.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { UsageAccounting } from "./accounting.ts";
import { VmReconciler } from "./reconciler.ts";
import { log } from "./log.ts";

export function startOperations(deps: {
  handle: DbHandle; store: Store; hub?: EventHub; provisioner?: Provisioner;
}) {
  const { handle, store, hub } = deps;
  const provisioner = deps.provisioner ?? new Provisioner(handle);
  const lifecycle = createRunLifecycle({ handle, store });
  const runService = new RunService(handle, store, hub);
  const scheduler = new Scheduler(handle, store, runService);
  const accounting = new UsageAccounting(handle);
  const reconciler = new VmReconciler(handle, provisioner.provider);

  const stopReaper = startReaper(handle, {
    onReap: async (jobs) => {
      for (const job of jobs) log("warn", "queue.lease_expired", {
        jobId: job.id, runId: job.runId, status: job.status, attempts: job.attempts,
      });
      await lifecycle.onReap(jobs);
    },
  });
  const stopProvisioner = process.env.KAPI_PROVISIONER === "off" ? () => {} : provisioner.start();
  const stopScheduler = process.env.KAPI_SCHEDULER === "off" ? () => {} : scheduler.start();
  const stopAccounting = accounting.start();
  const stopReconciler = process.env.KAPI_RECONCILER === "off" ? () => {} : reconciler.start();
  const reclaimTimer = setInterval(() => void (async () => {
    await accounting.settle();
    await provisioner.reclaim();
  })().catch(() => {}), 30_000);
  reclaimTimer.unref?.();

  return {
    provisioner, scheduler, accounting, reconciler,
    stop: async () => {
      stopReaper(); stopProvisioner(); stopScheduler(); stopAccounting(); stopReconciler();
      clearInterval(reclaimTimer);
      await accounting.settle().catch(() => {});
      await provisioner.destroyAll().catch(() => {});
    },
  };
}
