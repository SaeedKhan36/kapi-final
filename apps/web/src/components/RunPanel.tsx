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
  const [confirmCancel, setConfirmCancel] = useState(false);

  const roots = useMemo(() => toTree(state), [state]);
  const counts = useMemo(() => countByStatus(state), [state]);

  // Default to the root captain, and follow along if the selected agent is gone
  // (a different run was opened) rather than showing an empty panel.
  useEffect(() => {
    if (selected && state.nodes[selected]) return;
    setSelected(roots[0]?.node.jobId ?? null);
  }, [roots, selected, state.nodes]);

  useEffect(() => { setCancelling(false); setConfirmCancel(false); }, [run?.id]);

  if (!run) {
    return loading
      ? <Card className="flex items-center gap-2 p-6 text-sm text-muted"><Spinner /> loading run…</Card>
      : <Empty>Send a message to start a run.</Empty>;
  }

  const running = !isTerminal(state.status);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-muted">Run</h2>
            <Badge status={state.status} />
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-bright/90">{run.goal}</p>
          <p className="mt-1 font-mono text-xs text-muted">{run.id}</p>
          {run.error && <p className="mt-1 text-xs text-bad">{run.error}</p>}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <LiveDot connected={connected} />
          {running && (
            <Button
              variant="danger"
              className="px-2 py-1 text-xs"
              disabled={cancelling}
              onClick={() => {
                if (!confirmCancel) { setConfirmCancel(true); return; }
                setCancelling(true);
                onCancel();
              }}
            >
              {cancelling ? "cancelling…" : confirmCancel ? "Confirm cancel" : "Cancel run"}
            </Button>
          )}
        </div>
      </header>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <BudgetMeter label="Model requests" used={run.llmRequests} max={run.maxLlmRequests} />
          <BudgetMeter label="Tokens" used={run.llmTokens} max={run.maxTokens} />
          <BudgetMeter label="Spawns" used={run.totalSpawns} max={run.maxTotalSpawns} />
          <BudgetMeter label="VM time" used={run.vmSeconds} max={run.maxVmSeconds} suffix="s" />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted">
          <span>{state.order.length} agents</span>
          {Object.entries(counts).map(([status, n]) => <span key={status}>{status} {n}</span>)}
          <span className="ml-auto">depth ≤ {run.maxSpawnDepth}</span>
          <span>
            cost {run.costStatus === "unavailable"
              ? "unavailable"
              : `$${(run.usdCents / 100).toFixed(2)}/${(run.maxUsdCents / 100).toFixed(2)}`} ({run.costStatus})
          </span>
        </div>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Fleet</h2>
        <AgentTree roots={roots} selected={selected} onSelect={setSelected} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Trace</h2>
        <ActivityFeed node={selected ? state.nodes[selected] ?? null : null} />
      </section>
    </div>
  );
}

export function BudgetMeter(
  { label, used, max, suffix = "" }: { label: string; used: number; max: number; suffix?: string },
) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, used / max)) : 0;
  const tone = ratio >= .9 ? "bg-bad" : ratio >= .7 ? "bg-warn" : "bg-accent";
  return <div><div className="flex items-baseline justify-between gap-2 text-[10px]"><span className="uppercase tracking-wider text-muted">{label}</span><span className="font-mono text-bright/80">{used.toLocaleString()}{suffix}/{max.toLocaleString()}{suffix}</span></div><div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/70"><div className={`h-full rounded-full ${tone}`} style={{ width: `${ratio * 100}%` }} /></div></div>;
}
