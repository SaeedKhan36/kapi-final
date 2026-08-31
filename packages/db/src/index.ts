import { mkdirSync } from "node:fs";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.ts";
import { DDL, TABLES } from "./ddl.ts";
import { runMigrations } from "./migrations.ts";

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
export async function createDb(url = process.env.DATABASE_URL): Promise<DbHandle> {
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
    await handle.exec(DDL);
    await runMigrations(handle);
    await handle.exec(`
      CREATE OR REPLACE FUNCTION kapi_notify_event() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('kapi_events', json_build_object('runId', NEW.run_id, 'seq', NEW.seq)::text);
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS kapi_events_notify ON events;
      CREATE TRIGGER kapi_events_notify AFTER INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION kapi_notify_event();
    `);
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
