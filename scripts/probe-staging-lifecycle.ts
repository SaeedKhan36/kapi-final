import { loadEnv } from "@kapi/env";
loadEnv();

import { evaluateLifecycle, type LifecycleEvidence, type LifecycleThread } from "./staging-evidence.ts";

const base = required("KAPI_SMOKE_URL").replace(/\/$/, "");
const cookie = required("KAPI_SMOKE_COOKIE");
const projectId = required("KAPI_SMOKE_PROJECT_ID");
const goal = required("KAPI_STAGING_GOAL");
const timeoutMs = positiveNumber("KAPI_STAGING_TIMEOUT_SECONDS", 45 * 60) * 1000;
const pollMs = positiveNumber("KAPI_STAGING_POLL_SECONDS", 10) * 1000;
const headers = { cookie, "content-type": "application/json" };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

let runId: string | null = null;
let terminal = false;
try {
  const setup = await request<{ auth?: string; vault?: { configured?: boolean }; codex?: { connected?: boolean } }>(
    "GET", "/api/setup",
  );
  if (setup.auth !== "workos") throw new Error(`staging auth is ${setup.auth ?? "unknown"}, expected workos`);
  if (!setup.vault?.configured) throw new Error("staging vault is not configured");
  if (!setup.codex?.connected) throw new Error("the authenticated staging user has not connected Codex");

  const integrations = await request<{ github?: { configured?: boolean; installed?: boolean; reason?: string } }>(
    "GET", `/api/projects/${encodeURIComponent(projectId)}/integrations`,
  );
  if (!integrations.github?.configured || !integrations.github.installed) {
    throw new Error(integrations.github?.reason ?? "the GitHub App is not installed for the staging project");
  }

  const thread = await request<{ id: string }>(
    "POST", `/api/projects/${encodeURIComponent(projectId)}/threads`,
    { title: `Release probe ${new Date().toISOString()}` },
  );
  const started = await request<{ run: { id: string } }>(
    "POST", `/api/threads/${encodeURIComponent(thread.id)}/messages`, { content: goal },
  );
  runId = started.run.id;
  console.log(`started staging lifecycle run ${runId}`);

  const deadline = Date.now() + timeoutMs;
  let detail: LifecycleEvidence;
  while (true) {
    detail = await request<LifecycleEvidence>("GET", `/api/runs/${encodeURIComponent(runId)}`);
    console.log(`run ${runId}: ${detail.run.status}, ${detail.jobs.length} job(s), ${detail.events.length} event(s)`);
    if (["completed", "failed", "cancelled"].includes(detail.run.status)) {
      terminal = true;
      break;
    }
    if (Date.now() >= deadline) throw new Error(`run ${runId} did not finish within ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const threadDetail = await request<LifecycleThread>("GET", `/api/threads/${encodeURIComponent(thread.id)}`);
  const evidence = evaluateLifecycle(detail, threadDetail);
  for (const check of evidence.checks) {
    console.log(`${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  if (!evidence.ok) throw new Error(`staging lifecycle evidence is incomplete for run ${runId}`);
  console.log(`staging lifecycle passed for run ${runId}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (runId && !terminal && process.env.KAPI_STAGING_KEEP_FAILED_RUN !== "true") {
    await request("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`).then(
      () => console.error(`cancelled unfinished staging probe ${runId}`),
      (err) => console.error(`could not cancel unfinished staging probe ${runId}: ${String(err)}`),
    );
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
