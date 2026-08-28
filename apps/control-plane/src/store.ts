import type { DbHandle } from "@kapi/db";
import { newId, type Job } from "@kapi/protocol";
import { listJobs } from "@kapi/queue";

export type Project = {
  id: string; ownerId: string; name: string; repoUrl: string;
  defaultBranch: string; budgets: Record<string, number>; createdAt: Date;
};
export type Thread = { id: string; projectId: string; title: string | null; createdAt: Date };
export type Message = {
  id: string; threadId: string; role: string; content: string;
  runId: string | null; createdAt: Date;
};
export type Run = {
  id: string; threadId: string; projectId: string; goal: string; status: string;
  maxConcurrentVms: number; maxTotalSpawns: number; maxSpawnDepth: number;
  maxTokens: number; maxUsdCents: number;
  llmRequests: number; llmTokens: number; usdCents: number;
  totalSpawns: number; vmSeconds: number; eventSeq: number;
  error: string | null; createdAt: Date; finishedAt: Date | null;
};
export type EventRow = {
  id: string; runId: string; jobId: string | null; seq: number;
  kind: string; from: string; to: string | null;
  payload: Record<string, unknown>; ts: Date;
};

const d = (v: string | Date | null): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));
const n = (v: unknown): number => Number(v);

/**
 * Data access for the control plane's own tables. The queue owns `jobs`, so
 * this never writes there directly - it goes through @kapi/queue, which is what
 * keeps the events stream in step with job state.
 */
export class Store {
  constructor(private h: DbHandle) {}

  /* ------------------------------------------------------------ projects */

  async createProject(input: {
    ownerId: string; name: string; repoUrl: string; defaultBranch?: string;
    budgets?: Record<string, number>;
  }): Promise<Project> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `INSERT INTO projects (id, owner_id, name, repo_url, default_branch, budgets)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        newId("prj"), input.ownerId, input.name, input.repoUrl,
        input.defaultBranch ?? "main", JSON.stringify(input.budgets ?? {}),
      ],
    );
    return this.#project(rows[0]!);
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC`, [ownerId],
    );
    return rows.map((r) => this.#project(r));
  }

  /** Scoped by owner: a project you do not own is indistinguishable from one that does not exist. */
  async getProject(id: string, ownerId: string): Promise<Project | null> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM projects WHERE id = $1 AND owner_id = $2`, [id, ownerId],
    );
    return rows[0] ? this.#project(rows[0]) : null;
  }

  /* ------------------------------------------------------------- threads */

  async createThread(projectId: string, title?: string): Promise<Thread> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `INSERT INTO threads (id, project_id, title) VALUES ($1, $2, $3) RETURNING *`,
      [newId("thr"), projectId, title ?? null],
    );
    return this.#thread(rows[0]!);
  }

  async listThreads(projectId: string): Promise<Thread[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM threads WHERE project_id = $1 ORDER BY created_at DESC`, [projectId],
    );
    return rows.map((r) => this.#thread(r));
  }

  /** Joins through to the project so ownership can be checked in one query. */
  async getThreadForOwner(
    threadId: string, ownerId: string,
  ): Promise<{ thread: Thread; project: Project } | null> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT t.id AS t_id, t.project_id AS t_project_id, t.title AS t_title,
              t.created_at AS t_created_at, p.*
       FROM threads t JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1 AND p.owner_id = $2`,
      [threadId, ownerId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      thread: {
        id: r.t_id as string,
        projectId: r.t_project_id as string,
        title: (r.t_title as string) ?? null,
        createdAt: d(r.t_created_at as string)!,
      },
      project: this.#project(r),
    };
  }

  /* ------------------------------------------------------------ messages */

  async createMessage(input: {
    threadId: string; role: "user" | "captain" | "system"; content: string; runId?: string | null;
  }): Promise<Message> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `INSERT INTO messages (id, thread_id, role, content, run_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newId("msg"), input.threadId, input.role, input.content, input.runId ?? null],
    );
    return this.#message(rows[0]!);
  }

  async listMessages(threadId: string): Promise<Message[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at ASC`, [threadId],
    );
    return rows.map((r) => this.#message(r));
  }

  /* ---------------------------------------------------------------- runs */

  async createRun(input: {
    threadId: string; projectId: string; goal: string; budgets?: Record<string, number>;
  }): Promise<Run> {
    const b = input.budgets ?? {};
    const rows = await this.h.raw<Record<string, unknown>>(
      `INSERT INTO runs (id, thread_id, project_id, goal, status,
                         max_concurrent_vms, max_total_spawns, max_spawn_depth,
                         max_tokens, max_usd_cents)
       VALUES ($1, $2, $3, $4, 'queued',
               COALESCE($5, 12), COALESCE($6, 200), COALESCE($7, 4),
               COALESCE($8, 20000000), COALESCE($9, 2000))
       RETURNING *`,
      [
        newId("run"), input.threadId, input.projectId, input.goal,
        b.maxConcurrentVms ?? null, b.maxTotalSpawns ?? null, b.maxSpawnDepth ?? null,
        b.maxTokens ?? null, b.maxUsdCents ?? null,
      ],
    );
    return this.#run(rows[0]!);
  }

  async getRun(id: string): Promise<Run | null> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM runs WHERE id = $1`, [id],
    );
    return rows[0] ? this.#run(rows[0]) : null;
  }

  async listRuns(projectId: string): Promise<Run[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT * FROM runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [projectId],
    );
    return rows.map((r) => this.#run(r));
  }

  async runOwner(runId: string): Promise<string | null> {
    const rows = await this.h.raw<{ owner_id: string }>(
      `SELECT p.owner_id FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [runId],
    );
    return rows[0]?.owner_id ?? null;
  }

  async setRunStatus(runId: string, status: string, error?: string): Promise<void> {
    await this.h.raw(
      `UPDATE runs SET status = $2, error = COALESCE($3, error),
              finished_at = CASE WHEN $2 IN ('completed','failed','cancelled')
                                 THEN now() ELSE finished_at END
       WHERE id = $1`,
      [runId, status, error ?? null],
    );
  }

  async getRunDetail(runId: string): Promise<{
    run: Run; jobs: Job[]; agents: Record<string, unknown>[];
    events: EventRow[]; artifacts: Record<string, unknown>[];
  } | null> {
    const run = await this.getRun(runId);
    if (!run) return null;
    const [jobs, agents, events, artifacts] = await Promise.all([
      listJobs(this.h, runId),
      this.h.raw<Record<string, unknown>>(`SELECT * FROM agents WHERE run_id = $1`, [runId]),
      this.listEvents(runId),
      this.h.raw<Record<string, unknown>>(
        `SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`, [runId],
      ),
    ]);
    return { run, jobs, agents, events, artifacts };
  }

  /* -------------------------------------------------------------- events */

  /** Everything after `afterSeq`. The UI's resume path. */
  async listEvents(runId: string, afterSeq = 0, limit = 1000): Promise<EventRow[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      `SELECT id, run_id, job_id, seq, kind, from_agent, to_agent, payload, ts
       FROM events WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [runId, afterSeq, limit],
    );
    return rows.map((r) => this.#event(r));
  }

  /** Events across every run the owner can see, for a global feed. */
  async listEventsSince(afterId: string | null, limit = 500): Promise<EventRow[]> {
    const rows = await this.h.raw<Record<string, unknown>>(
      afterId
        ? `SELECT id, run_id, job_id, seq, kind, from_agent, to_agent, payload, ts
           FROM events WHERE id > $1 ORDER BY id ASC LIMIT $2`
        : `SELECT id, run_id, job_id, seq, kind, from_agent, to_agent, payload, ts
           FROM events ORDER BY id DESC LIMIT $2`,
      afterId ? [afterId, limit] : [limit],
    );
    const mapped = rows.map((r) => this.#event(r));
    return afterId ? mapped : mapped.reverse();
  }

  /* --------------------------------------------------------------- shape */

  #project(r: Record<string, unknown>): Project {
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      name: r.name as string,
      repoUrl: r.repo_url as string,
      defaultBranch: r.default_branch as string,
      budgets: (r.budgets as Record<string, number>) ?? {},
      createdAt: d(r.created_at as string)!,
    };
  }

  #thread(r: Record<string, unknown>): Thread {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      title: (r.title as string) ?? null,
      createdAt: d(r.created_at as string)!,
    };
  }

  #message(r: Record<string, unknown>): Message {
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      role: r.role as string,
      content: r.content as string,
      runId: (r.run_id as string) ?? null,
      createdAt: d(r.created_at as string)!,
    };
  }

  #run(r: Record<string, unknown>): Run {
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      projectId: r.project_id as string,
      goal: r.goal as string,
      status: r.status as string,
      maxConcurrentVms: n(r.max_concurrent_vms),
      maxTotalSpawns: n(r.max_total_spawns),
      maxSpawnDepth: n(r.max_spawn_depth),
      maxTokens: n(r.max_tokens),
      maxUsdCents: n(r.max_usd_cents),
      llmRequests: n(r.llm_requests),
      llmTokens: n(r.llm_tokens),
      usdCents: n(r.usd_cents),
      totalSpawns: n(r.total_spawns),
      vmSeconds: n(r.vm_seconds),
      eventSeq: n(r.event_seq),
      error: (r.error as string) ?? null,
      createdAt: d(r.created_at as string)!,
      finishedAt: d(r.finished_at as string | null),
    };
  }

  #event(r: Record<string, unknown>): EventRow {
    return {
      id: r.id as string,
      runId: r.run_id as string,
      jobId: (r.job_id as string) ?? null,
      seq: n(r.seq),
      kind: r.kind as string,
      from: r.from_agent as string,
      to: (r.to_agent as string) ?? null,
      payload: (r.payload as Record<string, unknown>) ?? {},
      ts: d(r.ts as string)!,
    };
  }
}
