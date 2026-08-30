import type {
  AgentChildrenResponse, AgentInboxMessage, AgentSpawnResponse, ModelTool,
  ModelResponse, SpawnRequest, WireMessage,
} from "@kapi/protocol";

/** What a tool gets when it runs. Everything here is local to the VM. */
export type ToolContext = {
  /** Absolute path to the repository checkout. */
  cwd: string;
  jobId: string;
  runId: string;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /** Asks the plane for a push credential, only when one is actually needed. */
  gitCredentials: () => Promise<GitCredentials>;
  /** Sends a question to the captain and waits, or gives up. */
  askCaptain: (question: string, timeoutMs?: number) => Promise<string | null>;
  /**
   * Present only for an agent allowed to command others - in practice a
   * captain. A build agent has no fleet, and the tools that need one are simply
   * not in its tool list, so the model never sees them.
   */
  fleet?: FleetOps;
  /**
   * False once the lease is lost or the job is cancelled. Long-running tools
   * must check it: a tool that waits ten minutes on a job the reaper already
   * reassigned is doing work for a run that has moved on without it.
   */
  alive?: () => boolean;
};

/** What an agent that commands other agents can do. All of it dials the plane. */
export type FleetOps = {
  spawn: (agents: SpawnRequest[]) => Promise<AgentSpawnResponse>;
  children: () => Promise<AgentChildrenResponse>;
  cancelChild: (jobId: string, reason?: string) => Promise<string[]>;
  /** Addresses a specific agent, e.g. answering a worker's question. */
  sendTo: (address: string, content: string) => Promise<void>;
  /** Anything addressed to this agent since the last call. */
  pollInbox: () => Promise<AgentInboxMessage[]>;
};

export type GitCredentials = {
  token: string;
  repoUrl: string | null;
  baseBranch: string;
  identity: { name: string; email: string };
};

export type ToolResult = {
  /** What the model sees. Always a string - models reason over text. */
  output: string;
  /** False marks the step as failed in the event stream, but never aborts. */
  ok?: boolean;
  /** Structured detail for the event stream and the final result. */
  meta?: Record<string, unknown>;
};

export type AgentTool = ModelTool & {
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Ends the loop when it succeeds. `finish` is the only one by default; a
   * role may mark others, e.g. a reviewer's verdict.
   */
  terminal?: boolean;
};

export type ModelCaller = (req: {
  tier?: "reasoning" | "coding" | "cheap";
  system: string;
  messages: WireMessage[];
  tools: ModelTool[];
  maxOutputTokens?: number;
}) => Promise<ModelResponse>;

export type LoopOutcome = {
  ok: boolean;
  summary: string;
  /** True when the step or budget cap stopped the loop rather than the agent. */
  incomplete: boolean;
  steps: number;
  filesTouched: string[];
  commits: string[];
  branch?: string;
  prUrl?: string;
  /** Structured output from the successful terminal tool, e.g. a review verdict. */
  terminalMeta?: Record<string, unknown>;
};
