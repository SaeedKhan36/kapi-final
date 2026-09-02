import { loadEnv } from "@kapi/env";
loadEnv();

import { serve } from "@hono/node-server";
import { connectDb, createDb } from "@kapi/db";
import { Authenticator, vaultConfigured } from "@kapi/identity";
import { Store } from "./store.ts";
import { EventHub } from "./events.ts";
import { createApp } from "./app.ts";
import { attachWebSocket } from "./ws.ts";
import { Provisioner } from "./provisioner.ts";
import { startOperations } from "./operations.ts";
import { validateProductionConfig } from "./config.ts";
import { RequestTracker } from "./request-tracker.ts";

validateProductionConfig();

const handle = process.env.NODE_ENV === "production" ? await connectDb() : await createDb();
const store = new Store(handle);
const hub = new EventHub(store, handle);
const auth = new Authenticator(handle);
const provisioner = new Provisioner(handle);
const requests = new RequestTracker();
const app = createApp({ handle, store, hub, auth, requests, vmProvider: provisioner.providerName });
const operations = process.env.KAPI_OPERATIONS === "off"
  ? null : startOperations({ handle, store, hub, provisioner });

const port = Number(process.env.PORT ?? process.env.CONTROL_PLANE_PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`\n  kapi control plane`);
  console.log(`  http  http://localhost:${port}`);
  console.log(`  ws    ws://localhost:${port}/ws`);
  console.log(`  db    ${handle.target}`);
  console.log(`  auth  ${auth.mode}${auth.mode === "dev" ? "  (NOT authenticated - set WORKOS_* for real auth)" : ""}`);
  console.log(`  vault ${vaultConfigured() ? "configured" : "NOT configured - set KAPI_SECRET_KEY"}`);
  console.log(`  vms   ${provisioner.providerName}${process.env.KAPI_PROVISIONER === "off" ? "  (provisioner off)" : ""}\n`);
});

const wss = attachWebSocket(server, hub, { auth, store });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting work first, then drain HTTP/WebSocket activity before the
  // database pool disappears underneath an in-flight request.
  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
  for (const client of wss.clients) client.close(1001, "server shutdown");
  wss.close();

  await operations?.stop();
  await hub.close();
  await requests.drain();

  const deadline = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10_000);
    timer.unref?.();
  });
  if (await Promise.race([httpClosed.then(() => "closed" as const), deadline]) === "timeout") {
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  }
  await httpClosed.catch(() => {});
  await handle.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
