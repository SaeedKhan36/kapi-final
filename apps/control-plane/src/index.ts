import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { createDb } from "@kapi/db";
import { Authenticator, vaultConfigured } from "@kapi/identity";
import { startReaper } from "@kapi/queue";
import { Store } from "./store.ts";
import { EventHub } from "./events.ts";
import { createApp } from "./app.ts";
import { attachWebSocket } from "./ws.ts";
import { Provisioner } from "./provisioner.ts";

const handle = await createDb();
const store = new Store(handle);
const hub = new EventHub(store, handle);
const auth = new Authenticator(handle);
const provisioner = new Provisioner(handle);
const app = createApp({ handle, store, hub, auth, vmProvider: provisioner.providerName });

/**
 * The reaper runs here for now. It is deliberately safe to run in several
 * processes at once (SKIP LOCKED), so moving it to its own worker later needs
 * no coordination.
 */
const stopReaper = startReaper(handle, {
  onReap: (jobs) => {
    for (const job of jobs) {
      console.log(`[reaper] ${job.id} ${job.status} after lease expiry (attempt ${job.attempts})`);
    }
  },
});

/**
 * Gives queued jobs a VM. Set KAPI_PROVISIONER=off to run the plane without
 * one - useful when driving jobs by hand.
 */
const stopProvisioner =
  process.env.KAPI_PROVISIONER === "off" ? () => {} : provisioner.start();

// Destroys VMs whose jobs have finished. Separate from the provisioner's own
// loop so a slow delete never delays starting the next job.
const reclaimTimer = setInterval(() => {
  void provisioner.reclaim().catch(() => {});
}, 30_000);
reclaimTimer.unref?.();

const port = Number(process.env.CONTROL_PLANE_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  kapi control plane`);
  console.log(`  http  http://localhost:${port}`);
  console.log(`  ws    ws://localhost:${port}/ws`);
  console.log(`  db    ${handle.target}`);
  console.log(`  auth  ${auth.mode}${auth.mode === "dev" ? "  (NOT authenticated - set WORKOS_* for real auth)" : ""}`);
  console.log(`  vault ${vaultConfigured() ? "configured" : "NOT configured - set KAPI_SECRET_KEY"}`);
  console.log(`  vms   ${provisioner.providerName}${process.env.KAPI_PROVISIONER === "off" ? "  (provisioner off)" : ""}\n`);
});

const wss = attachWebSocket(server, hub);

const shutdown = async () => {
  stopReaper();
  stopProvisioner();
  clearInterval(reclaimTimer);
  // Best effort: VMs this process started should not outlive it. Anything
  // missed is caught by the provider-side idle TTL.
  await provisioner.destroyAll().catch(() => {});
  hub.close();
  wss.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
