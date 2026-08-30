import type {
  Health, Job, Message, Principal, Project, Run, RunDetail, RunEvent, Thread,
} from "./types.ts";

const TOKEN_KEY = "kapi.token";

/**
 * The bearer token, when there is one.
 *
 * The plane runs `auth: "dev"` with WORKOS_* unset and authenticates nothing;
 * with them set every /api call needs an AuthKit token. Rather than build a
 * sign-in flow the plane cannot yet complete, the token is read from local
 * storage - so a real deployment works today by pasting one in, and dev needs
 * nothing at all.
 */
export const authToken = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value: string | null) =>
    value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = authToken.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(detail.error ?? `HTTP ${res.status}`, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  health: () => request<Health>("GET", "/api/health"),
  me: () => request<Principal>("GET", "/api/me"),

  listProjects: () => request<Project[]>("GET", "/api/projects"),
  createProject: (body: { name: string; repoUrl: string; defaultBranch?: string }) =>
    request<Project>("POST", "/api/projects", body),
  getProject: (id: string) =>
    request<{ project: Project; threads: Thread[]; runs: Run[] }>("GET", `/api/projects/${id}`),

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
