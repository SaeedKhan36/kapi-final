import type { ModelTool, ModelResponse, WireMessage } from "@kapi/protocol";

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
};
