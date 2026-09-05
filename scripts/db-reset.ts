import { loadEnv } from "@kapi/env";
loadEnv();

import { createDb, truncateAll } from "@kapi/db";

const handle = await createDb();
const force = process.argv.includes("--force");

if (!handle.embedded && !force) {
  console.error(
    `\n  Refusing to truncate ${handle.target}.\n` +
    `  This deletes every row in every table.\n` +
    `  Re-run with --force if that is what you mean.\n`,
  );
  await handle.close();
  process.exit(1);
}

await truncateAll(handle, { allowExternal: true });
console.log(`\n  wiped ${handle.target}\n`);
await handle.close();
