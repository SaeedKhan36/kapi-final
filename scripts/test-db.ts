import {
  createDb, createIsolatedTestSchema, type DbHandle,
} from "@kapi/db";

export type TestDb = {
  handle: DbHandle;
  close: () => Promise<void>;
};

/**
 * Opens a database that is safe for destructive test setup.
 *
 * A configured DATABASE_URL is application configuration, not permission to
 * erase its public schema. Real-Postgres tests therefore get a unique schema;
 * local tests get a fresh in-memory PGlite instance.
 */
export async function createTestDb(suite: string): Promise<TestDb> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const isolated = await createIsolatedTestSchema(databaseUrl, suite);
    try {
      const handle = await createDb(isolated.url);
      return {
        handle,
        close: async () => {
          await handle.close();
          await isolated.cleanup();
        },
      };
    } catch (error) {
      await isolated.cleanup();
      throw error;
    }
  }

  process.env.KAPI_PGLITE_DIR = `memory://${suite}-test`;
  const handle = await createDb("");
  return { handle, close: () => handle.close() };
}

/** Tests must not change behavior because a developer has configured integrations. */
export function useHermeticTestConfig(): void {
  process.env.NODE_ENV = "test";
  delete process.env.WORKOS_CLIENT_ID;
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_REDIRECT_URI;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_WEBHOOK_SECRET;
}
