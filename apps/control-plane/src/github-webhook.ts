import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { DbHandle } from "@kapi/db";
import { parseRepoUrl } from "@kapi/identity";
import { appendEvent } from "@kapi/queue";
import type { EventHub } from "./events.ts";
import type { Store } from "./store.ts";

type CheckPayload = {
  action?: string;
  repository?: { full_name?: string };
  sender?: { login?: string };
  installation?: { id?: number };
  check_run?: {
    id?: number; name?: string; status?: string; conclusion?: string | null;
    head_sha?: string; html_url?: string; details_url?: string;
    started_at?: string | null; completed_at?: string | null;
    check_suite?: { id?: number; head_branch?: string | null; head_sha?: string };
  };
  check_suite?: {
    id?: number; status?: string; conclusion?: string | null;
    head_branch?: string | null; head_sha?: string;
    latest_check_runs_count?: number;
  };
};

type CompletedCheck = {
  checkType: "check_run" | "check_suite";
  checkId: number | null;
  name: string;
  repository: string;
  branch: string | null;
  sha: string | null;
  conclusion: string | null;
  status: string;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  sender: string | null;
  installationId: number | null;
  checkRuns: number | null;
};

type RunMatch = { runId: string; jobId: string | null };

/** Constant-time verification of GitHub's sha256 webhook signature. */
export function validGithubSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Receives GitHub check webhooks and appends them to the same ordered stream
 * agents and browsers already consume. The route intentionally sits outside
 * /api auth: GitHub authenticates with the webhook signature, not WorkOS.
 */
export function createGithubWebhookRoutes(deps: {
  handle: DbHandle;
  store: Store;
  hub: EventHub;
}) {
  const { handle, store, hub } = deps;
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    const body = await c.req.text();
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (process.env.NODE_ENV === "production" && !secret) {
      return c.json({ error: "GitHub webhook authentication is not configured" }, 503);
    }
    if (secret && !validGithubSignature(body, c.req.header("x-hub-signature-256"), secret)) {
      return c.json({ error: "invalid GitHub webhook signature" }, 401);
    }

    const event = c.req.header("x-github-event") ?? "";
    if (event === "ping") return c.json({ ok: true, pong: true });
    if (event !== "check_run" && event !== "check_suite") {
      return c.json({ accepted: true, ignored: `unsupported event ${event || "(missing)"}` }, 202);
    }

    let payload: CheckPayload;
    try {
      payload = JSON.parse(body) as CheckPayload;
    } catch {
      return c.json({ error: "invalid JSON payload" }, 400);
    }

    const check = completedCheck(event, payload);
    if (!check) {
      return c.json({ accepted: true, ignored: "check has not completed" }, 202);
    }

    const match = await matchRun(handle, check.repository, check.branch);
    if (!match) {
      // A valid GitHub delivery should not be retried forever just because it
      // belongs to a branch/run Kapi no longer knows about.
      return c.json({ accepted: true, matched: false }, 202);
    }

    const deliveryId = c.req.header("x-github-delivery") ??
      `${event}:${check.checkId ?? "unknown"}:${check.sha ?? check.branch ?? "unknown"}`;
    const content = `${check.name} completed with ${check.conclusion ?? "no conclusion"}`;

    const seq = await handle.transaction(async (tx) => {
      // Serialise duplicate detection on the run row. GitHub retries can arrive
      // concurrently, and the event stream must contain one delivery once.
      await tx(`SELECT id FROM runs WHERE id = $1 FOR UPDATE`, [match.runId]);
      const prior = await tx<{ exists: boolean }>(
        `SELECT true AS exists FROM events
         WHERE run_id = $1 AND kind = 'ci.completed'
           AND payload->>'deliveryId' = $2 LIMIT 1`,
        [match.runId, deliveryId],
      );
      if (prior[0]?.exists) return null;

      return appendEvent(tx, {
        runId: match.runId,
        jobId: match.jobId,
        kind: "ci.completed",
        from: "orchestrator",
        to: "captain",
        payload: { ...check, deliveryId, content },
      });
    });

    if (seq !== null) {
      const [written] = await store.listEvents(match.runId, seq - 1, 1);
      if (written) hub.publish(written);
    }
    return c.json({ accepted: true, matched: true, duplicate: seq === null, runId: match.runId });
  });

  return app;
}

function completedCheck(event: string, payload: CheckPayload): CompletedCheck | null {
  if (payload.action !== "completed") return null;
  const repository = payload.repository?.full_name?.trim();
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) return null;

  if (event === "check_run") {
    const run = payload.check_run;
    if (!run || run.status !== "completed") return null;
    return {
      checkType: "check_run",
      checkId: run.id ?? null,
      name: run.name ?? "GitHub check run",
      repository,
      branch: run.check_suite?.head_branch ?? null,
      sha: run.head_sha ?? run.check_suite?.head_sha ?? null,
      conclusion: run.conclusion ?? null,
      status: run.status,
      url: run.details_url ?? run.html_url ?? null,
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
      sender: payload.sender?.login ?? null,
      installationId: payload.installation?.id ?? null,
      checkRuns: null,
    };
  }

  const suite = payload.check_suite;
  if (!suite || suite.status !== "completed") return null;
  return {
    checkType: "check_suite",
    checkId: suite.id ?? null,
    name: "GitHub check suite",
    repository,
    branch: suite.head_branch ?? null,
    sha: suite.head_sha ?? null,
    conclusion: suite.conclusion ?? null,
    status: suite.status,
    url: null,
    startedAt: null,
    completedAt: null,
    sender: payload.sender?.login ?? null,
    installationId: payload.installation?.id ?? null,
    checkRuns: suite.latest_check_runs_count ?? null,
  };
}

async function matchRun(
  sql: Pick<DbHandle, "raw">,
  repository: string,
  branch: string | null,
): Promise<RunMatch | null> {
  const sameRepo = (url: string) => {
    const ref = parseRepoUrl(url);
    return ref !== null && `${ref.owner}/${ref.repo}`.toLowerCase() === repository.toLowerCase();
  };

  if (branch) {
    const branchJobId = branch.startsWith("kapi/") ? branch.slice("kapi/".length) : null;
    if (branchJobId) {
      const rows = await sql.raw<{ run_id: string; job_id: string; repo_url: string }>(
        `SELECT j.run_id, j.id AS job_id, p.repo_url
         FROM jobs j JOIN runs r ON r.id = j.run_id
         JOIN projects p ON p.id = r.project_id WHERE j.id = $1`,
        [branchJobId],
      );
      const row = rows[0];
      if (row && sameRepo(row.repo_url)) return { runId: row.run_id, jobId: row.job_id };
    }

    const rows = await sql.raw<{ run_id: string; job_id: string; repo_url: string }>(
      `SELECT j.run_id, j.id AS job_id, p.repo_url
       FROM jobs j JOIN runs r ON r.id = j.run_id
       JOIN projects p ON p.id = r.project_id
       WHERE j.result->>'branch' = $1 ORDER BY j.created_at DESC LIMIT 20`,
      [branch],
    );
    const row = rows.find((candidate) => sameRepo(candidate.repo_url));
    if (row) return { runId: row.run_id, jobId: row.job_id };
  }

  // Some check-suite deliveries omit head_branch. Only infer a run when the
  // repository has exactly one active run; choosing among several would send
  // one captain another run's CI result.
  const active = await sql.raw<{ run_id: string; repo_url: string }>(
    `SELECT r.id AS run_id, p.repo_url FROM runs r
     JOIN projects p ON p.id = r.project_id
     WHERE r.status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY r.created_at DESC LIMIT 100`,
  );
  const candidates = active.filter((candidate) => sameRepo(candidate.repo_url));
  return candidates.length === 1 ? { runId: candidates[0]!.run_id, jobId: null } : null;
}
