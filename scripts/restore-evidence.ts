export const RESTORE_TABLES = [
  "users", "projects", "threads", "messages", "runs", "jobs", "agents", "events",
  "artifacts", "secrets", "connections", "schedules", "usage_ledger",
] as const;

export type RestoreTable = (typeof RESTORE_TABLES)[number];
export type RestoreCounts = Record<RestoreTable, number>;

export function parseExpectedCounts(value: string): RestoreCounts {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("KAPI_RESTORE_EXPECTED_COUNTS must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KAPI_RESTORE_EXPECTED_COUNTS must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const out = {} as RestoreCounts;
  for (const table of RESTORE_TABLES) {
    const count = record[table];
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new Error(`KAPI_RESTORE_EXPECTED_COUNTS.${table} must be a non-negative integer`);
    }
    out[table] = Number(count);
  }
  return out;
}

export function compareRestoreCounts(
  expected: RestoreCounts, actual: RestoreCounts,
): Array<{ table: RestoreTable; expected: number; actual: number }> {
  return RESTORE_TABLES.flatMap((table) => expected[table] === actual[table]
    ? []
    : [{ table, expected: expected[table], actual: actual[table] }]);
}
