import { loadEnv } from "@kapi/env";
loadEnv();

import { createDb, MIGRATIONS } from "@kapi/db";

const handle = await createDb();
console.log(`database ready at ${handle.target}; ${MIGRATIONS.length} migration(s) known`);
await handle.close();
