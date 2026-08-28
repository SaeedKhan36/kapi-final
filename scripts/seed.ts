import type { DbHandle } from "@kapi/db";
import { newId } from "@kapi/protocol";

export type Seeded = { userId: string; projectId: string; threadId: string; runId: string };

/** Minimum rows a job needs to satisfy its foreign keys. */
export async function seedRun(handle: DbHandle, goal = "test goal"): Promise<Seeded> {
  const userId = newId("usr");
  const projectId = newId("prj");
  const threadId = newId("thr");
  const runId = newId("run");

  await handle.raw(
    `INSERT INTO users (id, workos_id, email) VALUES ($1, $2, $3)`,
    [userId, `workos_${userId}`, "test@kapi.local"],
  );
  await handle.raw(
    `INSERT INTO projects (id, owner_id, name, repo_url) VALUES ($1, $2, $3, $4)`,
    [projectId, userId, "test", "https://github.com/kapi/test.git"],
  );
  await handle.raw(`INSERT INTO threads (id, project_id) VALUES ($1, $2)`, [threadId, projectId]);
  await handle.raw(
    `INSERT INTO runs (id, thread_id, project_id, goal) VALUES ($1, $2, $3, $4)`,
    [runId, threadId, projectId, goal],
  );

  return { userId, projectId, threadId, runId };
}

/** Another run under the same project, for cross-run concurrency tests. */
export async function seedSiblingRun(handle: DbHandle, s: Seeded): Promise<string> {
  const runId = newId("run");
  await handle.raw(
    `INSERT INTO runs (id, thread_id, project_id, goal) VALUES ($1, $2, $3, $4)`,
    [runId, s.threadId, s.projectId, "sibling"],
  );
  return runId;
}
