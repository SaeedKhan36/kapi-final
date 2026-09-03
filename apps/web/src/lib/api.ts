import type { Run, RunDetail } from "./types.ts";

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const configuredBase = String(viteEnv?.VITE_API_URL ?? "").replace(/\/$/, "");
export const apiBase = configuredBase && !/^https?:\/\//.test(configuredBase)
  ? `https://${configuredBase}`
  : configuredBase;

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

const get = <T>(path: string) => fetch(`${apiBase}${path}`).then(json<T>);

export const api = {
  health: () => get<{ ok: boolean; database: string; provider: string; llmConfigured: boolean; pushEnabled: boolean }>("/api/health"),
  listRuns: () => get<Run[]>("/api/runs"),
  getRun: (id: string) => get<RunDetail>(`/api/runs/${id}`),
  createRun: (body: { goal: string; repoUrl: string; baseBranch?: string; maxConcurrency?: number; maxTasks?: number }) =>
    fetch(`${apiBase}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ runId: string }>),
};
