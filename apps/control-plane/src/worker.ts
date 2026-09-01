import { loadEnv } from "@kapi/env";
loadEnv();

import { connectDb, createDb } from "@kapi/db";
import { Store } from "./store.ts";
import { startOperations } from "./operations.ts";
import { validateProductionConfig } from "./config.ts";

validateProductionConfig("worker");

const handle = process.env.NODE_ENV === "production" ? await connectDb() : await createDb();
const store = new Store(handle);
const operations = startOperations({ handle, store });
console.log(`[worker] operations started (${operations.provisioner.providerName}, ${handle.target})`);

let resolveShutdown!: () => void;
const shutdownSignal = new Promise<void>((resolve) => { resolveShutdown = resolve; });
process.once("SIGINT", resolveShutdown);
process.once("SIGTERM", resolveShutdown);
await shutdownSignal;
await operations.stop();
await handle.close();
