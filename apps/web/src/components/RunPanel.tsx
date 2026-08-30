import { useEffect, useMemo, useState } from "react";
import { countByStatus, toTree, type RunState } from "~/lib/agents.ts";
import { isTerminal } from "~/lib/useRun.ts";
import type { Run } from "~/lib/types.ts";
import { AgentTree } from "./AgentTree.tsx";
import { ActivityFeed } from "./ActivityFeed.tsx";
import { Badge, Button, Card, Empty, ErrorNote, LiveDot, Spinner } from "./ui.tsx";

export function RunPanel(
  { run, state, connected, loading, error, onCancel }: {
    run: Run | null;
    state: RunState;
    connected: boolean;
    loading: boolean;
    error: string | null;
    onCancel: () => void;
  },
) {
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const roots = useMemo(() => toTree(state), [state]);
  const counts = useMemo(() => countByStatus(state), [state]);

  // Default to the root captain, and follow along if the selected agent is gone
  // (a different run was opened) rather than showing an empty panel.
  useEffect(() => {
    if (selected && state.nodes[selected]) return;
    setSelected(roots[0]?.node.jobId ?? null);
  }, [roots, selected, state.nodes]);

  useEffect(() => { setCancelling(false); }, [run?.id]);

  if (!run) {
    return loading
      ? <Card className="flex items-center gap-2 p-6 text-sm text-muted"><Spinner /> loading run…</Card>
      : <Empty>Send a message to start a run.</Empty>;
  }

  const running = !isTerminal(state.status);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={state.status} />
          <span className="font-mono text-[11px] text-muted">{run.id}</span>
          <div className="ml-auto flex items-center gap-3">
            <LiveDot connected={connected} />
            {running && (
              <Button
                variant="danger"
                className="px-2 py-1 text-xs"
                disabled={cancelling}
                onClick={() => { setCancelling(true); onCancel(); }}
              >
                {cancelling ? "cancelling…" : "Cancel run"}
              </Button>
            )}
          </div>
        </div>

        <p className="mt-2 line-clamp-2 text-sm text-bright/90">{run.goal}</p>
        {run.error && <p className="mt-1 text-xs text-bad">{run.error}</p>}

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
          <span>{state.order.length} agents</span>
          {Object.entries(counts).map(([status, n]) => <span key={status}>{status} {n}</span>)}
          <span className="text-muted/70">
            {run.llmRequests} llm calls · {run.llmTokens.toLocaleString()} tokens
          </span>
          <span className="text-muted/70">
            spawns {run.totalSpawns}/{run.maxTotalSpawns} · depth ≤ {run.maxSpawnDepth}
          </span>
        </div>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted">Fleet</h2>
        <AgentTree roots={roots} selected={selected} onSelect={setSelected} />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium text-muted">Trace</h2>
        <ActivityFeed node={selected ? state.nodes[selected] ?? null : null} />
      </div>
    </div>
  );
}
