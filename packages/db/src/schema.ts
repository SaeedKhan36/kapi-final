import {
  pgTable, text, timestamp, integer, bigint, boolean, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JobPayload, JobResult, ReviewVerdict } from "@kapi/protocol";

/* ------------------------------------------------------------------ */
/* Control plane                                                       */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** WorkOS subject. The only identity kapi stores. */
  workosId: text("workos_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** Defaults every run on this project inherits. See `runs` for the fields. */
    budgets: jsonb("budgets").$type<Record<string, number>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("projects_owner_idx").on(t.ownerId)],
);

/** A conversation against a project. One thread may drive many runs. */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_project_idx").on(t.projectId, t.createdAt)],
);

/** Human <-> captain chat turns. Distinct from `events`, which is machine trace. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** Set when this turn started or came from a run. */
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

/**
 * One captain invocation.
 *
 * `budgets` are the ONLY limit on how much a captain may spawn. There is no
 * task cap and no fixed workflow: when a budget is reached the captain is told
 * so as a tool result and decides what to do, rather than the run being killed.
 */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("queued"),

    maxConcurrentVms: integer("max_concurrent_vms").notNull().default(12),
    maxTotalSpawns: integer("max_total_spawns").notNull().default(200),
    maxSpawnDepth: integer("max_spawn_depth").notNull().default(4),
    maxTokens: integer("max_tokens").notNull().default(20_000_000),
    maxLlmRequests: integer("max_llm_requests").notNull().default(1_000),
    maxVmSeconds: integer("max_vm_seconds").notNull().default(86_400),
    maxUsdCents: integer("max_usd_cents").notNull().default(2_000),

    llmRequests: integer("llm_requests").notNull().default(0),
    llmTokens: integer("llm_tokens").notNull().default(0),
    usdCents: integer("usd_cents").notNull().default(0),
    usdMicros: bigint("usd_micros", { mode: "number" }).notNull().default(0),
    costStatus: text("cost_status").notNull().default("unavailable"),
    totalSpawns: integer("total_spawns").notNull().default(0),
    vmSeconds: integer("vm_seconds").notNull().default(0),

    /** Scheduling provenance. Null for interactive runs. */
    scheduleId: text("schedule_id"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

    /**
     * Monotonic event counter for this run, bumped in the same transaction as
     * every append. Serialises event writes per run - deliberate: an ordered,
     * gap-free cursor is what makes UI resume and state replay correct, and
     * per-run event volume is far too low for that lock to matter.
     */
    eventSeq: integer("event_seq").notNull().default(0),

    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("runs_schedule_occurrence_idx").on(t.scheduleId, t.scheduledFor),
  ],
);

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

/**
 * The work queue. VMs claim from here over HTTPS; nothing pushes to a VM.
 *
 * This table is what kapi-old lacked. There, the whole run lived in one
 * in-process drain loop, so an orchestrator restart killed it. Here a job is
 * durable and leased: the process holding it can die and the reaper hands the
 * job to someone else.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    /** The job that spawned this one. Null for a run's root captain. */
    parentJobId: text("parent_job_id"),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("queued"),

    payload: jsonb("payload").$type<JobPayload>().notNull(),
    result: jsonb("result").$type<JobResult>(),

    /** The VM currently holding the lease. */
    vmId: text("vm_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    priority: integer("priority").notNull().default(0),

    /** Job ids that must SUCCEED first. A real array, so the claim SQL can gate on it. */
    dependsOn: text("depends_on").array().notNull().default([]),

    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // Drives the claim scan: filter by status+kind, order by priority then age.
    index("jobs_claim_idx").on(t.status, t.kind, t.priority, t.createdAt),
    index("jobs_run_idx").on(t.runId),
    index("jobs_parent_idx").on(t.parentJobId),
    // The reaper scans only leased rows.
    index("jobs_lease_idx").on(t.leaseExpiresAt),
  ],
);

/** One row per agent process. Mirrors a job, but tracks liveness rather than work. */
export const agents = pgTable(
  "agents",
  {
    jobId: text("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("starting"),
    vmId: text("vm_id"),
    provider: text("provider"),
    /** How deep in the spawn tree. Enforces maxSpawnDepth without recursing. */
    depth: integer("depth").notNull().default(0),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    accountedThrough: timestamp("accounted_through", { withTimezone: true }),
  },
  (t) => [index("agents_run_idx").on(t.runId, t.status)],
);

/* ------------------------------------------------------------------ */
/* Stream and outputs                                                  */
/* ------------------------------------------------------------------ */

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    jobId: text("job_id"),
    /** Monotonic within a run. The UI's resume cursor. */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    from: text("from_agent").notNull(),
    to: text("to_agent"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_run_seq_idx").on(t.runId, t.seq),
    index("events_job_idx").on(t.jobId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    jobId: text("job_id"),
    kind: text("kind").notNull(),
    body: jsonb("body").$type<ReviewVerdict | Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("artifacts_run_idx").on(t.runId, t.kind)],
);

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

/**
 * Encrypted at rest, never returned over the API - only injected into a VM.
 * `scope` is what makes per-task BYO keys work: a task-scoped secret wins over
 * a project one, which wins over a user one.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("secrets_scope_name_idx").on(t.scope, t.scopeId, t.name)],
);

/** OAuth grants: Codex subscription, GitHub App installations. */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    /** Encrypted grant blob. Same envelope as `secrets`. */
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connections_user_provider_idx").on(t.userId, t.provider)],
);

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    goal: text("goal").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
    lastSkippedAt: timestamp("last_skipped_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("schedules_next_idx").on(t.enabled, t.nextRunAt),
    uniqueIndex("schedules_thread_idx").on(t.threadId),
  ],
);

/** Append-only audit trail. Aggregate counters on runs are maintained in the same transaction. */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    usdMicros: bigint("usd_micros", { mode: "number" }).notNull().default(0),
    costStatus: text("cost_status").notNull().default("unavailable"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_ledger_job_period_idx").on(t.jobId, t.kind, t.periodEnd),
    index("usage_ledger_run_idx").on(t.runId, t.createdAt),
  ],
);
