import type {
  Connection, Health, Job, Message, Principal, Project, ProjectIntegrations, Run, RunDetail,
  RunEvent, Schedule, SecretMeta, SecretScope, Setup, Thread,
} from "./types.ts";

// `import.meta.env` exists in Vite, but not when deterministic UI components
// are rendered under Node in the lightweight test suite.
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const configuredBase = String(viteEnv?.VITE_API_URL ?? "").replace(/\/$/, "");
export const apiBase = configuredBase && !/^https?:\/\//.test(configuredBase)
  ? `https://${configuredBase}` : configuredBase;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (res.status === 401 && !retried && path !== "/api/health") {
    const refreshed = await fetch(`${apiBase}/auth/refresh`, { method: "POST", credentials: "include" });
    if (refreshed.ok) return request<T>(method, path, body, true);
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(detail.error ?? `HTTP ${res.status}`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  loginUrl: (returnTo = location.href) => `${apiBase}/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  logout: () => request<void>("POST", "/auth/logout"),
  health: () => request<Health>("GET", "/api/health"),
  me: () => request<Principal>("GET", "/api/me"),
  setup: () => request<Setup>("GET", "/api/setup"),
  connections: () => request<Connection[]>("GET", "/api/connections"),
  startCodexConnection: (returnTo = location.href) =>
    request<{ url: string; state: string }>("POST", "/api/connections/codex/start", { returnTo }),
  disconnectCodex: () => request<{ disconnected: boolean }>("DELETE", "/api/connections/codex"),

  listProjects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (body: { name: string; repoUrl: string; defaultBranch?: string }) =>
    request<Project>("POST", "/api/projects", body),
  getProject: (id: string) =>
    request<{ project: Project; threads: Thread[]; runs: Run[] }>("GET", `/api/projects/${id}`),
  projectIntegrations: (id: string) =>
    request<ProjectIntegrations>("GET", `/api/projects/${id}/integrations`),

  listSecrets: (scope: SecretScope, scopeId: string) =>
    request<SecretMeta[]>("GET", `/api/secrets?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`),
  putSecret: (body: { scope: SecretScope; scopeId: string; name: string; value: string }) =>
    request<SecretMeta>("PUT", "/api/secrets", body),
  deleteSecret: (scope: SecretScope, scopeId: string, name: string) =>
    request<{ deleted: boolean }>(
      "DELETE", `/api/secrets/${scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(name)}`,
    ),

  listSchedules: (projectId: string) =>
    request<Schedule[]>("GET", `/api/projects/${projectId}/schedules`),
  createSchedule: (projectId: string, body: {
    name: string; cron: string; timezone: string; goal: string; enabled?: boolean;
  }) => request<Schedule>("POST", `/api/projects/${projectId}/schedules`, body),
  updateSchedule: (id: string, body: Partial<{
    name: string; cron: string; timezone: string; goal: string; enabled: boolean;
  }>) => request<Schedule>("PATCH", `/api/schedules/${id}`, body),
  deleteSchedule: (id: string) => request<void>("DELETE", `/api/schedules/${id}`),
  runSchedule: (id: string) => request<{ run: Run }>("POST", `/api/schedules/${id}/run`),

  createThread: (projectId: string, title?: string) =>
    request<Thread>("POST", `/api/projects/${projectId}/threads`, title ? { title } : {}),
  getThread: (id: string) =>
    request<{ thread: Thread; project: Project; messages: Message[] }>("GET", `/api/threads/${id}`),

  /** Starts work: records the turn, opens a run, queues the root captain. */
  postMessage: (threadId: string, content: string) =>
    request<{ message: Message; run: Run; job: { id: string } }>(
      "POST", `/api/threads/${threadId}/messages`, { content },
    ),

  getRun: (id: string) => request<RunDetail>("GET", `/api/runs/${id}`),
  runEvents: (id: string, after: number) =>
    request<RunEvent[]>("GET", `/api/runs/${id}/events?after=${after}`),
  cancelRun: (id: string) => request<{ cancelled: number }>("POST", `/api/runs/${id}/cancel`),
  getJob: (id: string) => request<Job>("GET", `/api/jobs/${id}`),
};
