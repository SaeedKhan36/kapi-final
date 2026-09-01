import type { ReactNode } from "react";
import { Badge, Empty, RoleChip } from "./ui.tsx";
import { cn } from "~/lib/cn.ts";
import type { TreeNode } from "~/lib/agents.ts";

/**
 * The fleet as the captain built it.
 *
 * Drawn as a spawn tree rather than the old build's dependency waves: there is
 * no plan here to lay out in levels. A captain spawns when it decides to, often
 * after seeing what an earlier agent came back with, so "who spawned whom" is
 * the only structure that exists - and it is the structure worth watching.
 */
export function AgentTree(
  { roots, selected, onSelect }:
  { roots: TreeNode[]; selected: string | null; onSelect: (jobId: string) => void },
) {
  if (roots.length === 0) {
    return <Empty>No agents yet — the captain is being provisioned.</Empty>;
  }
  return (
    <div className="space-y-1.5">
      {roots.map((entry) => (
        <Branch key={entry.node.jobId} entry={entry} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Branch(
  { entry, selected, onSelect }:
  { entry: TreeNode; selected: string | null; onSelect: (jobId: string) => void },
) {
  const { node } = entry;
  const isSelected = selected === node.jobId;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node.jobId)}
        className={cn(
          "block w-full rounded-lg border px-3 py-2 text-left transition-colors",
          "hover:border-accent/50",
          isSelected ? "border-accent/60 bg-raised/50" : "border-line/60 bg-surface/70",
          node.status === "failed" && !isSelected && "border-bad/40",
          node.status === "running" && !isSelected && "border-accent/30",
        )}
      >
        <div className="flex items-center gap-2">
          <RoleChip role={node.role} />
          <span className="font-mono text-[11px] text-muted">{node.kind}</span>
          <Badge status={node.status} className="ml-auto" />
        </div>

        <p className="mt-1.5 line-clamp-2 text-sm text-bright/90">
          {node.instruction || <span className="text-muted">no instruction recorded</span>}
        </p>

        {node.summary && (
          <p className="mt-1 line-clamp-2 text-xs text-muted">{node.summary}</p>
        )}
        {node.error && <p className="mt-1 line-clamp-2 text-xs text-bad">{node.error}</p>}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted">
          <span>{node.jobId}</span>
          {node.attempts > 1 && <Tag tone="warn">attempt {node.attempts}</Tag>}
          {node.branch && <Tag>{node.branch}</Tag>}
          {node.prUrl && <Tag tone="accent">PR ready</Tag>}
          {node.ci && (
            <Tag tone={node.ci.conclusion === "success" ? "ok" : "bad"}>
              ci: {node.ci.conclusion ?? "done"}
            </Tag>
          )}
          {node.verdict && (
            <Tag tone={node.verdict.decision === "approve" ? "ok" : "warn"}>
              {node.verdict.decision === "approve" ? "approved" : "changes requested"}
            </Tag>
          )}
          {node.activity.length > 0 && <span className="ml-auto">{node.activity.length} events</span>}
        </div>
      </button>

      {/* Nesting the wrapper is what draws the depth: every level adds one
          rail, so a sub-captain's fleet reads as its own subtree. */}
      {entry.children.length > 0 && (
        <div className="ml-3 mt-1.5 space-y-1.5 border-l border-line/40 pl-3">
          {entry.children.map((child) => (
            <Branch key={child.node.jobId} entry={child} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  muted: "border-line/60 text-muted",
  accent: "border-accent/40 text-accent",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  bad: "border-bad/40 text-bad",
};

const Tag = ({ tone = "muted", children }: { tone?: string; children: ReactNode }) => (
  <span className={cn("rounded border px-1.5 py-0.5", TONE[tone] ?? TONE.muted)}>{children}</span>
);
