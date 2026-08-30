import { jobIdOf, type Job, type JobKind, type JobStatus, type ReviewVerdict, type RunEvent } from "./types.ts";

/** One line in an agent's trace. Derived from events, never fetched. */
export type Activity = {
  seq: number;
  ts: string;
  kind: "status" | "thought" | "tool" | "log" | "message" | "spawn" | "ci" | "verdict";
  text: string;
  /** Secondary line: a tool's arguments, a message's address, a check's URL. */
  detail?: string;
  tone?: "muted" | "accent" | "ok" | "warn" | "bad";
};

export type CiCheck = {
  name: string;
  conclusion: string | null;
  branch: string | null;
  url: string | null;
};

export type AgentNode = {
  jobId: string;
  parentJobId: string | null;
  kind: JobKind;
  role: string;
  status: JobStatus;
  instruction: string;
  attempts: number;
  vmId: string | null;
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  error: string | null;
  verdict: ReviewVerdict | null;
  ci: CiCheck | null;
  activity: Activity[];
};

export type RunState = {
  status: string;
  /** Discovery order, which is spawn order - stable across re-renders. */
  order: string[];
  nodes: Record<string, AgentNode>;
};

/** How much trace to keep per agent. A long run is unbounded; a browser is not. */
const MAX_ACTIVITY = 400;

export const emptyRunState = (status = "queued"): RunState => ({ status, order: [], nodes: {} });

const blankNode = (jobId: string): AgentNode => ({
  jobId,
  parentJobId: null,
  kind: "build",
  role: "generalist",
  status: "queued",
  instruction: "",
  attempts: 0,
  vmId: null,
  summary: null,
  branch: null,
  prUrl: null,
  error: null,
  verdict: null,
  ci: null,
  activity: [],
});

/**
 * Seeds the tree from the job rows.
 *
 * `jobs` is authoritative for parentage and final results in a way the event
 * stream alone is not: a page opened halfway through a run would otherwise have
 * to replay every `agent.spawned` from seq 0 to know who spawned whom.
 */
export function seedFromJobs(jobs: Job[], status: string): RunState {
  const state = emptyRunState(status);
  for (const job of jobs) {
    state.order.push(job.id);
    state.nodes[job.id] = {
      ...blankNode(job.id),
      parentJobId: job.parentJobId,
      kind: job.kind,
      role: job.role,
      status: job.status,
      instruction: job.payload?.instruction ?? "",
      attempts: job.attempts,
      vmId: job.vmId,
      summary: job.result?.summary ?? null,
      branch: job.result?.branch ?? null,
      prUrl: job.result?.prUrl ?? null,
      error: job.error,
      verdict: job.result?.review ?? null,
    };
  }
  return state;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const STATUS_TONE: Partial<Record<JobStatus, Activity["tone"]>> = {
  succeeded: "ok",
  failed: "bad",
  cancelled: "warn",
  running: "accent",
};

/**
 * Folds one event into the tree.
 *
 * Returns a new state when something changed and the SAME state when nothing
 * did, so React can skip a render for the events this view does not show.
 */
export function applyEvent(state: RunState, event: RunEvent): RunState {
  const payload = event.payload ?? {};

  if (event.kind === "run.status") {
    const status = str(payload.status);
    return status && status !== state.status ? { ...state, status } : state;
  }

  // Which agent the event is *about*. `agent.spawned` is the exception: it is
  // written against the child, but it is the parent that did something.
  const subject = event.kind === "agent.spawned"
    ? jobIdOf(event.from)
    : event.jobId ?? jobIdOf(event.from);

  let next = state;

  const edit = (jobId: string, change: (node: AgentNode) => AgentNode): void => {
    const existing = next.nodes[jobId] ?? blankNode(jobId);
    const updated = change(existing);
    next = {
      ...next,
      order: next.nodes[jobId] ? next.order : [...next.order, jobId],
      nodes: { ...next.nodes, [jobId]: updated },
    };
  };

  const note = (jobId: string, activity: Omit<Activity, "seq" | "ts">): void => {
    edit(jobId, (node) => ({
      ...node,
      activity: [...node.activity, { ...activity, seq: event.seq, ts: event.ts }]
        .slice(-MAX_ACTIVITY),
    }));
  };

  switch (event.kind) {
    case "job.status": {
      if (!event.jobId) break;
      const status = (str(payload.status) ?? "queued") as JobStatus;
      const detail = str(payload.detail);
      edit(event.jobId, (node) => ({
        ...node,
        status,
        vmId: str(payload.vmId) ?? node.vmId,
        attempts: typeof payload.attempts === "number" ? payload.attempts : node.attempts,
        summary: status === "succeeded" ? detail ?? node.summary : node.summary,
        // A reaped job that later succeeds on its second attempt must not keep
        // showing why the first one died - that reads as a failure it isn't.
        error: status === "succeeded" ? null : status === "failed" ? detail ?? node.error : node.error,
      }));
      note(event.jobId, {
        kind: "status",
        text: status,
        detail: detail ?? undefined,
        tone: STATUS_TONE[status] ?? "muted",
      });
      break;
    }

    case "agent.spawned": {
      const childId = str(payload.childJobId);
      if (!childId) break;
      edit(childId, (node) => ({
        ...node,
        parentJobId: subject ?? node.parentJobId,
        kind: (str(payload.kind) as JobKind) ?? node.kind,
        role: str(payload.role) ?? node.role,
        instruction: str(payload.instruction) ?? node.instruction,
      }));
      if (subject) {
        note(subject, {
          kind: "spawn",
          text: `spawned ${str(payload.role) ?? "an"} agent`,
          detail: str(payload.instruction) ?? undefined,
          tone: "accent",
        });
      }
      break;
    }

    case "log": {
      if (!subject) break;
      const message = str(payload.message) ?? "";
      const tool = str(payload.tool);
      // The loop logs a step's thinking and its tool calls through the same
      // event kind; the payload is what tells them apart.
      if (payload.kind === "thought") {
        note(subject, { kind: "thought", text: message, tone: "muted" });
      } else if (tool) {
        note(subject, {
          kind: "tool",
          text: tool,
          detail: payload.input ? JSON.stringify(payload.input) : message || undefined,
          tone: "accent",
        });
      } else {
        note(subject, { kind: "log", text: message, tone: "muted" });
      }
      break;
    }

    case "tool.call":
    case "tool.result": {
      if (!subject) break;
      const ok = payload.ok;
      note(subject, {
        kind: "tool",
        text: str(payload.tool) ?? event.kind,
        detail: payload.args ? JSON.stringify(payload.args) : undefined,
        tone: ok === false ? "bad" : "accent",
      });
      break;
    }

    case "agent.message": {
      if (!subject) break;
      note(subject, {
        kind: "message",
        text: str(payload.content) ?? "",
        detail: event.to ? `→ ${event.to}` : undefined,
        tone: payload.question ? "warn" : "muted",
      });
      break;
    }

    case "ci.completed": {
      const check: CiCheck = {
        name: str(payload.name) ?? "GitHub check",
        conclusion: str(payload.conclusion),
        branch: str(payload.branch),
        url: str(payload.url),
      };
      if (event.jobId) {
        edit(event.jobId, (node) => ({ ...node, ci: check }));
        note(event.jobId, {
          kind: "ci",
          text: `${check.name}: ${check.conclusion ?? "completed"}`,
          detail: check.branch ?? undefined,
          tone: check.conclusion === "success" ? "ok" : "bad",
        });
      }
      break;
    }

    case "review.verdict": {
      const reviewer = str(payload.reviewerJobId) ?? subject;
      if (!reviewer) break;
      const verdict: ReviewVerdict = {
        decision: (str(payload.decision) as ReviewVerdict["decision"]) ?? "approve",
        summary: str(payload.summary) ?? "",
        findings: Array.isArray(payload.findings) ? (payload.findings as ReviewVerdict["findings"]) : [],
        acceptanceMet: Array.isArray(payload.acceptanceMet) ? (payload.acceptanceMet as boolean[]) : [],
      };
      edit(reviewer, (node) => ({ ...node, verdict }));
      note(reviewer, {
        kind: "verdict",
        text: verdict.decision === "approve" ? "approved" : "requested changes",
        detail: verdict.summary,
        tone: verdict.decision === "approve" ? "ok" : "warn",
      });
      break;
    }
  }

  return next;
}

/**
 * Folds a job row's `result` into the node the event stream already built.
 *
 * `job.status` carries the summary and nothing else, so a branch, a pull
 * request or a verdict only exists on the job row. Without this an agent that
 * finished while you were watching shows less than the same agent does after a
 * refresh, which reads as the UI losing information it once had.
 *
 * Status is deliberately NOT taken from here: the stream is the one ordering,
 * and a late reply must not walk a node backwards.
 */
export function mergeJobResult(state: RunState, job: Job): RunState {
  const existing = state.nodes[job.id];
  if (!existing) return state;
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [job.id]: {
        ...existing,
        attempts: job.attempts,
        vmId: job.vmId ?? existing.vmId,
        summary: job.result?.summary ?? existing.summary,
        branch: job.result?.branch ?? existing.branch,
        prUrl: job.result?.prUrl ?? existing.prUrl,
        error: job.status === "succeeded" ? null : job.error ?? existing.error,
        verdict: job.result?.review ?? existing.verdict,
      },
    },
  };
}

export type TreeNode = { node: AgentNode; children: TreeNode[] };

/**
 * Arranges the flat node map into the spawn tree.
 *
 * A node whose parent is not (yet) known is treated as a root rather than
 * dropped - the root captain has no parent by design, and a child seen through
 * `job.status` before its `agent.spawned` arrives would otherwise vanish from
 * the view for as long as the gap lasts.
 */
export function toTree(state: RunState): TreeNode[] {
  const wrapped = new Map<string, TreeNode>();
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node) wrapped.set(id, { node, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const id of state.order) {
    const entry = wrapped.get(id);
    if (!entry) continue;
    const parent = entry.node.parentJobId ? wrapped.get(entry.node.parentJobId) : undefined;
    if (parent && parent !== entry) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

export const countByStatus = (state: RunState): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node) counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
};
