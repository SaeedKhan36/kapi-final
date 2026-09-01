import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";
import { DDL, TABLES } from "./ddl.ts";
import { MIGRATIONS, runMigrations, runMigrationsIn } from "./migrations.ts";

export * as schema from "./schema.ts";
export { schema as tables };
export { DDL, TABLES } from "./ddl.ts";
export { MIGRATIONS, runMigrations } from "./migrations.ts";

/**
 * The Drizzle client.
 *
 * Typed against the postgres-js driver for both backends. The PGlite driver is
 * a different class with the same query-builder surface, so it is cast: the
 * schema is identical, and one type here beats a union every caller must narrow.
 */
export type Db = PostgresJsDatabase<typeof schema>;

/** Runs parameterised SQL. The queue works at this level, not through Drizzle. */
export type SqlRunner = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

export type DbHandle = {
  /** Drizzle client, for ordinary application queries. */
  db: Db;
  raw: SqlRunner;
  /**
   * Runs `fn` in a transaction. The queue needs this so a job's state change
   * and its `events` row are written together or not at all.
   */
  transaction: <T>(fn: (tx: SqlRunner) => Promise<T>) => Promise<T>;
  /** Multi-statement DDL. */
  exec: (sql: string) => Promise<void>;
  close: () => Promise<void>;
  /** Postgres LISTEN/NOTIFY; absent for embedded PGlite. */
  listen?: (channel: string, onMessage: (payload: string) => void) => Promise<() => Promise<void>>;
  target: string;
  /**
   * True for PGlite. Single-process, so transactions serialise and
   * FOR UPDATE SKIP LOCKED is never actually contended - which is why the
   * queue's concurrency test refuses to run here.
   */
  embedded: boolean;
};

/**
 * Postgres, two ways, one schema:
 *   DATABASE_URL set   -> real Postgres (Neon, or a local container)
 *   DATABASE_URL unset -> embedded PGlite in .kapi/db
 *
 * PGlite is genuine Postgres compiled to WASM, so day-one development needs no
 * account, no container, and no network, and the schema is identical when
 * DATABASE_URL later points at a real server.
 */
export type CreateDbOptions = {
  /** Production services connect and verify; migration/bootstrap jobs opt in. */
  bootstrap?: boolean;
};

const EVENT_TRIGGER_DDL = `
  CREATE OR REPLACE FUNCTION kapi_notify_event() RETURNS trigger AS $$
  BEGIN
    PERFORM pg_notify('kapi_events', json_build_object('runId', NEW.run_id, 'seq', NEW.seq)::text);
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS kapi_events_notify ON events;
  CREATE TRIGGER kapi_events_notify AFTER INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION kapi_notify_event();
`;

export async function createDb(
  url = process.env.DATABASE_URL,
  options: CreateDbOptions = {},
): Promise<DbHandle> {
  if (url) {
    const [{ drizzle }, postgresMod] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const client = postgresMod.default(url, {
      max: Number(process.env.KAPI_DB_POOL_MAX ?? 24),
      // Required for pgbouncer-style poolers (Neon's -pooler endpoints).
      prepare: false,
      /**
       * Close our own idle connections before the server closes them for us.
       *
       * Neon's pooler drops idle connections, and a connection reaped on the
       * server side surfaces as a mid-query CONNECTION_CLOSED on the next use.
       * Recycling client-side keeps that failure out of application code.
       */
      idle_timeout: Number(process.env.KAPI_DB_IDLE_TIMEOUT ?? 20),
      max_lifetime: Number(process.env.KAPI_DB_MAX_LIFETIME ?? 60 * 30),
      connect_timeout: 30,
      // The idempotent DDL emits a NOTICE per "IF NOT EXISTS" that already
      // exists. Dozens of them on every boot drown out real output.
      onnotice: () => {},
    });

    const handle: DbHandle = {
      db: drizzle(client, { schema }),
      raw: async <T,>(sql: string, params: unknown[] = []) =>
        (await client.unsafe(sql, params as never[])) as unknown as T[],
      transaction: <T,>(fn: (tx: SqlRunner) => Promise<T>) =>
        client.begin(async (tx) =>
          fn(async <R,>(sql: string, params: unknown[] = []) =>
            (await tx.unsafe(sql, params as never[])) as unknown as R[]),
        ) as Promise<T>,
      // `.simple()` is required: the extended protocol rejects multi-statement SQL.
      exec: async (sql: string) => { await client.unsafe(sql).simple(); },
      close: () => client.end({ timeout: 5 }),
      listen: async (channel, onMessage) => {
        const listener = await client.listen(channel, onMessage);
        return async () => {
          await listener.unlisten();
          // postgres.js implements LISTEN on a private, dedicated one-client
          // pool (`listen.sql`). Ending the main query pool does not end that
          // socket, so explicitly close it during application shutdown.
          const listenSql = (client.listen as typeof client.listen & {
            sql?: { end: (options?: { timeout?: number }) => Promise<void> };
          }).sql;
          if (listenSql) await listenSql.end({ timeout: 5 });
        };
      },
      target: describeDbTarget(url),
      embedded: false,
    };
    try {
      const shouldBootstrap = options.bootstrap ?? process.env.NODE_ENV !== "production";
      if (shouldBootstrap) {
        // DDL, migrations and trigger replacement are one atomic, database-wide
        // writer. Concurrent local/test startups wait here instead of deadlocking
        // while taking incompatible relation locks in different orders.
        await client.begin(async (tx) => {
          const run: SqlRunner = async <T,>(sql: string, params: unknown[] = []) =>
            (await tx.unsafe(sql, params as never[])) as unknown as T[];
          await run(`SELECT pg_advisory_xact_lock(hashtextextended('kapi:schema-bootstrap', 0))`);
          await tx.unsafe(DDL).simple();
          await runMigrationsIn(run);
          await tx.unsafe(EVENT_TRIGGER_DDL).simple();
        });
      } else {
        await verifyMigrationState(handle);
      }
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
    return handle;
  }

  const [{ drizzle }, { PGlite }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("@electric-sql/pglite"),
  ]);
  // "memory://" gives a throwaway database with no files on disk, which is what
  // the test suite wants: a clean schema every run, no truncate ceremony.
  const dir = process.env.KAPI_PGLITE_DIR ?? ".kapi/db";
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);

  const handle: DbHandle = {
    db: drizzle(client, { schema }) as unknown as Db,
    raw: async <T,>(sql: string, params: unknown[] = []) =>
      (await client.query<T>(sql, params)).rows,
    transaction: <T,>(fn: (tx: SqlRunner) => Promise<T>) =>
      client.transaction(async (tx) =>
        fn(async <R,>(sql: string, params: unknown[] = []) =>
          (await tx.query<R>(sql, params)).rows),
      ) as Promise<T>,
    exec: async (sql: string) => { await client.exec(sql); },
    close: () => client.close(),
    target: describeDbTarget(undefined),
    embedded: true,
  };
  await handle.exec(DDL);
  await runMigrations(handle);
  return handle;
}

/** Runtime service path: connect and verify only, never write schema. */
export const connectDb = (url = process.env.DATABASE_URL) =>
  createDb(url, { bootstrap: false });

/** Migration/local bootstrap path: the only API allowed to write schema. */
export const bootstrapDb = (url = process.env.DATABASE_URL) =>
  createDb(url, { bootstrap: true });

/** Fails startup clearly when pre-deploy migrations did not run. */
export async function verifyMigrationState(handle: DbHandle): Promise<void> {
  try {
    const table = await handle.raw<{ present: string | null }>(
      `SELECT to_regclass('schema_migrations')::text AS present`,
    );
    if (!table[0]?.present) throw new Error("schema_migrations is missing");
    const applied = await handle.raw<{ version: number }>(`SELECT version FROM schema_migrations`);
    const versions = new Set(applied.map((row) => Number(row.version)));
    const missing = MIGRATIONS.filter((migration) => !versions.has(migration.version));
    if (missing.length > 0) {
      throw new Error(`missing migration(s): ${missing.map((m) => `${m.version}:${m.name}`).join(", ")}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`database is not ready (${detail}); run pnpm db:migrate before starting services`);
  }
}

/** Retries only deadlocked Postgres transactions, which PostgreSQL has rolled back. */
export async function retryDeadlockedTransaction<T>(
  handle: DbHandle,
  fn: (tx: SqlRunner) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await handle.transaction(fn);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (handle.embedded || code !== "40P01" || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(40, 5 * (2 ** (attempt - 1)))));
    }
  }
}

/** Creates an exact, disposable schema so concurrent real-Postgres tests never share rows. */
export async function createIsolatedTestSchema(
  databaseUrl: string,
  suite: string,
): Promise<{ url: string; schema: string; cleanup: () => Promise<void> }> {
  const postgres = (await import("postgres")).default;
  const safeSuite = suite.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
  const schemaName = `kapi_test_${safeSuite}_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  if (!/^kapi_test_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe generated test schema");

  const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  const scoped = new URL(databaseUrl);
  // Neon only permits a custom search_path on its direct endpoint.
  scoped.hostname = scoped.hostname.replace("-pooler.", ".");
  // `options=-csearch_path=...` survives PgBouncer/Neon startup parameter
  // filtering; a bare `search_path` query parameter is silently discarded.
  scoped.searchParams.set("options", `-csearch_path=${schemaName}`);
  let cleaned = false;
  return {
    url: scoped.toString(),
    schema: schemaName,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

export function describeDbTarget(url = process.env.DATABASE_URL): string {
  if (!url) return `pglite (embedded, ${process.env.KAPI_PGLITE_DIR ?? ".kapi/db"})`;
  try {
    const u = new URL(url);
    return `postgres ${u.hostname}${u.pathname}`;
  } catch {
    return "postgres (unparsable DATABASE_URL)";
  }
}

/** Wipes every table. Test setup and `pnpm db:reset`. */
export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE;`);
}
