export type Run = {
  id: string; goal: string; repoUrl: string; baseBranch: string;
  integrationBranch: string; status: string; sandboxProvider: string;
  plan: TaskGraph | null; error: string | null; prUrl: string | null;
  llmRequests: number; llmTokens: number;
  createdAt: string; finishedAt: string | null;
};

export type TaskGraph = {
  goal: string;
  contract: {
    summary: string;
    endpoints: Array<{ method: string; path: string; description: string; requestShape?: string; responseShape?: string }>;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string; notes?: string }> }>;
    conventions: string[];
  };
  tasks: Array<{ id: string; title: string; instruction: string; role: string; dependsOn: string[]; touches: string[]; acceptance: string[] }>;
};

export type Task = {
  runId: string; taskId: string; title: string; instruction: string; role: string;
  status: string; dependsOn: string[]; touches: string[]; acceptance: string[];
  assignedTo: string | null; branch: string | null; error: string | null;
  startedAt: string | null; finishedAt: string | null;
};

export type Agent = {
  runId: string; agentId: string; role: string; status: string;
  sandboxId: string | null; branch: string | null;
  startedAt: string; stoppedAt: string | null;
};

export type Message = {
  id: string; runId: string; taskId: string | null;
  from: string; to: string; type: string; content: string;
  files: Array<{ path: string; action: string }> | null;
  replyTo: string | null; ts: string;
};

export type RunDetail = { run: Run; tasks: Task[]; agents: Agent[]; messages: Message[]; artifacts: unknown[] };

export type RunEvent =
  | { kind: "status"; runId: string; status: string; detail?: string }
  | { kind: "message"; message: Message }
  | { kind: "plan"; runId: string; graph: TaskGraph }
  | { kind: "task"; runId: string; taskId: string; status: string; detail?: string };
