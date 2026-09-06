import { loadEnv } from "@kapi/env";
loadEnv();

import { connectDb, type DbHandle } from "@kapi/db";
import { decrypt } from "@kapi/identity";
import {
  RESTORE_TABLES, compareRestoreCounts, parseExpectedCounts, type RestoreCounts,
} from "./restore-evidence.ts";

const snapshotMode = process.argv.includes("--snapshot");
const url = snapshotMode
  ? required("DATABASE_URL")
  : required("KAPI_RESTORE_DATABASE_URL");

if (!snapshotMode && process.env.KAPI_RESTORE_CONFIRM_ISOLATED !== "true") {
  throw new Error("set KAPI_RESTORE_CONFIRM_ISOLATED=true after confirming the URL is a separate restored database");
}

const handle = await connectDb(url);
try {
  const counts = await tableCounts(handle);
  if (snapshotMode) {
    // Counts contain no row data or secret values and can be saved with backup evidence.
    console.log(JSON.stringify(counts));
  } else {
    const expected = parseExpectedCounts(required("KAPI_RESTORE_EXPECTED_COUNTS"));
    const differences = compareRestoreCounts(expected, counts);
    for (const table of RESTORE_TABLES) {
      console.log(`${differences.some((item) => item.table === table) ? "FAIL" : "ok"} ${table}: ${counts[table]}`);
    }
    if (differences.length) {
      throw new Error(`restore count mismatch: ${differences.map((item) =>
        `${item.table} expected=${item.expected} actual=${item.actual}`).join(", ")}`);
    }

    await verifyIntegrity(handle);
    await verifyEncryption(handle);
    console.log(`restore verified at ${handle.target}`);
  }
} finally {
  await handle.close();
}

async function tableCounts(handle: DbHandle): Promise<RestoreCounts> {
  const out = {} as RestoreCounts;
  for (const table of RESTORE_TABLES) {
    const rows = await handle.raw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

async function verifyIntegrity(handle: DbHandle): Promise<void> {
  const [cursorMismatch] = await handle.raw<{ n: number }>(
    `SELECT count(*)::int AS n FROM runs r
     WHERE r.event_seq <> COALESCE((SELECT max(e.seq) FROM events e WHERE e.run_id=r.id), 0)`,
  );
  if (Number(cursorMismatch?.n ?? 0) !== 0) {
    throw new Error(`${cursorMismatch?.n} run(s) have an event cursor mismatch`);
  }

  const [leaseMismatch] = await handle.raw<{ n: number }>(
    `SELECT count(*)::int AS n FROM agents a JOIN jobs j ON j.id=a.job_id
     WHERE a.stopped_at IS NULL AND j.status IN ('succeeded','failed','cancelled')`,
  );
  if (Number(leaseMismatch?.n ?? 0) !== 0) {
    throw new Error(`${leaseMismatch?.n} terminal job(s) still have an active agent row`);
  }
  console.log("ok event cursors and active leases are consistent");
}

async function verifyEncryption(handle: DbHandle): Promise<void> {
  const rows = await handle.raw<{ ciphertext: string; iv: string; tag: string }>(
    `SELECT ciphertext,iv,tag FROM secrets UNION ALL
     SELECT ciphertext,iv,tag FROM connections`,
  );
  for (const row of rows) decrypt(row);
  console.log(`ok ${rows.length} encrypted record(s) decrypt with KAPI_SECRET_KEY`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
