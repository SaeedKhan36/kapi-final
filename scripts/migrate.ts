import { loadEnv } from "@kapi/env";
loadEnv();

import { bootstrapDb, MIGRATIONS } from "@kapi/db";

const handle = await bootstrapDb();
console.log(`database ready at ${handle.target}; ${MIGRATIONS.length} migration(s) known`);
await handle.close();
