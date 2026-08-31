import { CronExpressionParser } from "cron-parser";
import type { DbHandle, SqlRunner } from "@kapi/db";
import { newId } from "@kapi/protocol";
import { RunService, type StartedRun } from "./run-service.ts";
import { Store, type Project, type Thread } from "./store.ts";

export type Schedule = {
  id: string; projectId: string; threadId: string; name: string;
  cron: string; timezone: string; goal: string; enabled: boolean;
  lastRunAt: Date | null; lastScheduledAt: Date | null; lastSkippedAt: Date | null;
  lastStatus: string | null; lastError: string | null; nextRunAt: Date | null;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null;
};

export type ScheduleInput = {
  name: string; cron: string; timezone: string; goal: string; enabled?: boolean;
};

const asDate = (value: unknown): Date | null => value == null ? null : new Date(value as string);

export function validateTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error(`invalid IANA timezone: ${timezone}`); }
}

export function nextOccurrence(cron: string, timezone: string, after = new Date()): Date {
  validateTimezone(timezone);
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

/** CRUD plus a multi-instance-safe due-schedule worker. */
export class Scheduler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(
    private handle: DbHandle,
    private store: Store,
    private runs: RunService,
    private intervalMs = Number(process.env.KAPI_SCHEDULER_INTERVAL_MS ?? 15_000),
  ) {}

  start(): () => void {
    this.#timer = setInterval(() => void this.tick().catch((err) => {
      console.error("[scheduler] tick failed", err);
    }), this.intervalMs);
    this.#timer.unref?.();
    void this.tick().catch(() => {});
    return () => this.stop();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  async list(projectId: string): Promise<Schedule[]> {
    const rows = await this.handle.raw<Record<string, unknown>>(
      `SELECT * FROM schedules WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [projectId],
    );
    return rows.map(scheduleFromRow);
  }

  async get(id: string, ownerId: string): Promise<Schedule | null> {
    const rows = await this.handle.raw<Record<string, unknown>>(
      `SELECT s.* FROM schedules s JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND p.owner_id = $2 AND s.deleted_at IS NULL`, [id, ownerId],
    );
    return rows[0] ? scheduleFromRow(rows[0]) : null;
  }

  async create(project: Project, input: ScheduleInput): Promise<Schedule> {
    const next = input.enabled === false ? null : nextOccurrence(input.cron, input.timezone);
    return this.handle.transaction(async (tx) => {
      const thread = await this.store.createThreadIn(tx, project.id, input.name);
      const rows = await tx<Record<string, unknown>>(
        `INSERT INTO schedules
          (id, project_id, thread_id, name, cron, timezone, goal, enabled, next_run_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [newId("sch"), project.id, thread.id, input.name, input.cron, input.timezone,
          input.goal, input.enabled ?? true, next?.toISOString() ?? null],
      );
      return scheduleFromRow(rows[0]!);
    });
  }

  async update(id: string, ownerId: string, patch: Partial<ScheduleInput>): Promise<Schedule | null> {
    const current = await this.get(id, ownerId);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const next = merged.enabled ? nextOccurrence(merged.cron, merged.timezone) : null;
    const rows = await this.handle.raw<Record<string, unknown>>(
      `UPDATE schedules SET name=$3, cron=$4, timezone=$5, goal=$6, enabled=$7,
         next_run_at=$8, updated_at=now(), last_error=NULL
       WHERE id=$1 AND EXISTS (SELECT 1 FROM projects WHERE id=project_id AND owner_id=$2)
         AND deleted_at IS NULL RETURNING *`,
      [id, ownerId, merged.name, merged.cron, merged.timezone, merged.goal, merged.enabled,
        next?.toISOString() ?? null],
    );
    if (!rows[0]) return null;
    await this.handle.raw(`UPDATE threads SET title=$2 WHERE id=$1`, [rows[0].thread_id, merged.name]);
    return scheduleFromRow(rows[0]);
  }

  async remove(id: string, ownerId: string): Promise<boolean> {
    const rows = await this.handle.raw<{ id: string }>(
      `UPDATE schedules SET enabled=false, next_run_at=NULL, deleted_at=now(), updated_at=now()
       WHERE id=$1 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM projects WHERE id=project_id AND owner_id=$2)
       RETURNING id`, [id, ownerId],
    );
    return rows.length > 0;
  }

  async runNow(id: string, ownerId: string): Promise<{ run?: StartedRun; skipped?: true } | null> {
    const outcome = await this.handle.transaction(async (tx) => {
      const rows = await tx<Record<string, unknown>>(
        `SELECT s.*,p.owner_id,p.name AS project_name,p.repo_url,p.default_branch,p.budgets
         FROM schedules s JOIN projects p ON p.id=s.project_id
         WHERE s.id=$1 AND p.owner_id=$2 AND s.deleted_at IS NULL
         FOR UPDATE OF s`, [id, ownerId],
      );
      const row = rows[0];
      if (!row) return null;
      const schedule = scheduleFromRow(row);
      const active = await tx<{ id: string }>(
        `SELECT id FROM runs WHERE schedule_id=$1 AND status NOT IN ('completed','failed','cancelled') LIMIT 1`,
        [schedule.id],
      );
      if (active.length) return { skipped: true as const };
      const project: Project = {
        id: schedule.projectId, ownerId: row.owner_id as string, name: row.project_name as string,
        repoUrl: row.repo_url as string, defaultBranch: row.default_branch as string,
        budgets: (row.budgets as Record<string, number>) ?? {}, createdAt: new Date(),
      };
      const started = await this.runs.startIn(tx, {
        thread: threadFor(schedule), project, goal: schedule.goal, messageRole: "system",
        scheduleId: schedule.id, scheduledFor: new Date(),
      });
      await tx(
        `UPDATE schedules SET last_run_at=now(), last_status='started', last_error=NULL, updated_at=now()
         WHERE id=$1`, [id],
      );
      return { run: started };
    });
    if (outcome?.run) await this.runs.publish(outcome.run.run.id);
    return outcome;
  }

  async tick(limit = 20, now = new Date()): Promise<{ started: string[]; skipped: string[] }> {
    if (this.#busy) return { started: [], skipped: [] };
    this.#busy = true;
    const result = { started: [] as string[], skipped: [] as string[] };
    try {
      for (let i = 0; i < limit; i++) {
        const outcome = await this.handle.transaction((tx) => this.#claimOne(tx, now));
        if (!outcome) break;
        if (outcome.run) {
          result.started.push(outcome.run.run.id);
          await this.runs.publish(outcome.run.run.id);
        } else if (outcome.scheduleId) result.skipped.push(outcome.scheduleId);
      }
      return result;
    } finally { this.#busy = false; }
  }

  async #claimOne(tx: SqlRunner, now: Date): Promise<{ run?: StartedRun; scheduleId?: string } | null> {
    const rows = await tx<Record<string, unknown>>(
      `SELECT s.*, p.owner_id, p.name AS project_name, p.repo_url, p.default_branch, p.budgets
       FROM schedules s JOIN projects p ON p.id=s.project_id
       WHERE s.enabled=true AND s.deleted_at IS NULL AND s.next_run_at <= $1
       ORDER BY s.next_run_at ASC FOR UPDATE OF s SKIP LOCKED LIMIT 1`, [now.toISOString()],
    );
    const row = rows[0];
    if (!row) return null;
    const schedule = scheduleFromRow(row);
    const due = schedule.nextRunAt!;
    const next = nextOccurrence(schedule.cron, schedule.timezone, due);
    const active = await tx<{ id: string }>(
      `SELECT id FROM runs WHERE schedule_id=$1 AND status NOT IN ('completed','failed','cancelled') LIMIT 1`,
      [schedule.id],
    );
    if (active.length > 0) {
      await tx(
        `UPDATE schedules SET last_scheduled_at=$2, last_skipped_at=now(), last_status='skipped_overlap',
        next_run_at=$3, updated_at=now() WHERE id=$1`,
        [schedule.id, due.toISOString(), next.toISOString()],
      );
      return { scheduleId: schedule.id };
    }

    const project: Project = {
      id: schedule.projectId, ownerId: row.owner_id as string,
      name: row.project_name as string, repoUrl: row.repo_url as string,
      defaultBranch: row.default_branch as string,
      budgets: (row.budgets as Record<string, number>) ?? {}, createdAt: new Date(),
    };
    const run = await this.runs.startIn(tx, {
      thread: threadFor(schedule), project, goal: schedule.goal, messageRole: "system",
      scheduleId: schedule.id, scheduledFor: due,
    });
    await tx(
      `UPDATE schedules SET last_run_at=now(), last_scheduled_at=$2, last_status='started',
       last_error=NULL, next_run_at=$3, updated_at=now() WHERE id=$1`,
      [schedule.id, due.toISOString(), next.toISOString()],
    );
    return { run };
  }

}

const threadFor = (s: Schedule): Thread => ({
  id: s.threadId, projectId: s.projectId, title: s.name, createdAt: s.createdAt,
});

function scheduleFromRow(r: Record<string, unknown>): Schedule {
  return {
    id: r.id as string, projectId: r.project_id as string, threadId: r.thread_id as string,
    name: r.name as string, cron: r.cron as string, timezone: r.timezone as string,
    goal: r.goal as string, enabled: Boolean(r.enabled),
    lastRunAt: asDate(r.last_run_at), lastScheduledAt: asDate(r.last_scheduled_at),
    lastSkippedAt: asDate(r.last_skipped_at), lastStatus: (r.last_status as string) ?? null,
    lastError: (r.last_error as string) ?? null, nextRunAt: asDate(r.next_run_at),
    createdAt: asDate(r.created_at)!, updatedAt: asDate(r.updated_at)!, deletedAt: asDate(r.deleted_at),
  };
}
