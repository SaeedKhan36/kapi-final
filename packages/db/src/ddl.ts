/**
 * Idempotent DDL, kept in lockstep with schema.ts.
 *
 * drizzle-kit owns migrations for a deployed database, but this exists so that
 * `pnpm test:unit` works against a bare `docker run postgres` and against
 * embedded PGlite with no migration step at all. A test suite that needs setup
 * ceremony is a test suite that stops being run.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workos_id TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  budgets JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS threads_project_idx ON threads (project_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  max_concurrent_vms INTEGER NOT NULL DEFAULT 12,
  max_total_spawns INTEGER NOT NULL DEFAULT 200,
  max_spawn_depth INTEGER NOT NULL DEFAULT 4,
  max_tokens INTEGER NOT NULL DEFAULT 20000000,
  max_llm_requests INTEGER NOT NULL DEFAULT 1000,
  max_vm_seconds INTEGER NOT NULL DEFAULT 86400,
  max_usd_cents INTEGER NOT NULL DEFAULT 2000,
  llm_requests INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  usd_cents INTEGER NOT NULL DEFAULT 0,
  usd_micros BIGINT NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'unavailable',
  total_spawns INTEGER NOT NULL DEFAULT 0,
  vm_seconds INTEGER NOT NULL DEFAULT 0,
  schedule_id TEXT,
  scheduled_for TIMESTAMPTZ,
  event_seq INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_thread_idx ON runs (thread_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_job_id TEXT,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload JSONB NOT NULL,
  result JSONB,
  vm_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, kind, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_run_idx ON jobs (run_id);
CREATE INDEX IF NOT EXISTS jobs_parent_idx ON jobs (parent_job_id);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_expires_at);

CREATE TABLE IF NOT EXISTS agents (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting',
  vm_id TEXT,
  provider TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  accounted_through TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agents_run_idx ON agents (run_id, status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_run_seq_idx ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS events_job_idx ON events (job_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id TEXT,
  kind TEXT NOT NULL,
  body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id, kind);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS secrets_scope_name_idx ON secrets (scope, scope_id, name);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_user_provider_idx ON connections (user_id, provider);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  goal TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_scheduled_at TIMESTAMPTZ,
  last_skipped_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS schedules_next_idx ON schedules (enabled, next_run_at);

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
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_job_period_idx
  ON usage_ledger (job_id, kind, period_end);
CREATE INDEX IF NOT EXISTS usage_ledger_run_idx ON usage_ledger (run_id, created_at);
`;

/** Every table, in dependency order for TRUNCATE. */
export const TABLES = [
  "events", "artifacts", "usage_ledger", "agents", "jobs", "runs", "messages", "threads",
  "schedules", "projects", "connections", "secrets", "users",
] as const;
