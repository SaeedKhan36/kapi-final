import type { DbHandle } from "./index.ts";

type Migration = { version: number; name: string; sql: string };

/**
 * Small, versioned SQL migrations for deployed databases. DDL remains the
 * zero-setup test/bootstrap path; migrations are what safely advance an
 * existing Render database whose CREATE TABLE statements are already no-ops.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase-9-operations",
    sql: `
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS max_llm_requests INTEGER NOT NULL DEFAULT 1000;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS max_vm_seconds INTEGER NOT NULL DEFAULT 86400;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS usd_micros BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'unavailable';
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS schedule_id TEXT;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS runs_schedule_occurrence_idx ON runs (schedule_id, scheduled_for);

      ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS accounted_through TIMESTAMPTZ;

      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS name TEXT;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_skipped_at TIMESTAMPTZ;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_status TEXT;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_error TEXT;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      INSERT INTO threads (id, project_id, title)
        SELECT 'thr_schedule_' || substr(md5(s.id), 1, 20), s.project_id, COALESCE(s.name, 'Scheduled work')
        FROM schedules s WHERE s.thread_id IS NULL
        ON CONFLICT (id) DO NOTHING;
      UPDATE schedules SET
        thread_id = COALESCE(thread_id, 'thr_schedule_' || substr(md5(id), 1, 20)),
        name = COALESCE(name, 'Scheduled work');
      ALTER TABLE schedules ALTER COLUMN thread_id SET NOT NULL;
      ALTER TABLE schedules ALTER COLUMN name SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS schedules_thread_idx ON schedules (thread_id);

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        usd_micros BIGINT NOT NULL DEFAULT 0,
        cost_status TEXT NOT NULL DEFAULT 'unavailable',
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_job_period_idx ON usage_ledger (job_id, kind, period_end);
      CREATE INDEX IF NOT EXISTS usage_ledger_run_idx ON usage_ledger (run_id, created_at);
    `,
  },
];

export async function runMigrations(handle: DbHandle): Promise<void> {
  await handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  for (const migration of MIGRATIONS) {
    await handle.transaction(async (tx) => {
      const existing = await tx<{ version: number }>(
        `SELECT version FROM schema_migrations WHERE version = $1`, [migration.version],
      );
      if (existing.length > 0) return;
      for (const statement of migration.sql.split(";").map((s) => s.trim()).filter(Boolean)) {
        await tx(statement);
      }
      await tx(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
    });
  }
}
