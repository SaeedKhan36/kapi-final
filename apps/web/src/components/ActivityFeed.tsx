import { useEffect, useRef } from "react";
import { cn } from "~/lib/cn.ts";
import type { AgentNode } from "~/lib/agents.ts";
import { Card } from "./ui.tsx";

const TONE: Record<string, string> = {
  muted: "text-muted",
  accent: "text-accent",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour12: false });

/**
 * One agent's trace, as it happens.
 *
 * The plane's `log` events carry the loop's thinking and its tool calls alike,
 * so the distinction is drawn here rather than pretended away: a thought reads
 * as prose, a tool call as a call.
 */
export function ActivityFeed({ node }: { node: AgentNode | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [node?.activity.length, node?.jobId]);

  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  if (!node) {
    return <Card className="p-6 text-center text-sm text-muted">Select an agent to watch it work.</Card>;
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line/40 px-3 py-2">
        <span className="font-mono text-[11px] text-muted">{node.jobId}</span>
        {node.vmId && <span className="font-mono text-[10px] text-muted">vm {node.vmId}</span>}
        {node.prUrl && <a className="ml-auto text-xs font-medium text-accent hover:underline" href={node.prUrl} target="_blank" rel="noreferrer">Open pull request ↗</a>}
      </div>

      <div
        ref={ref}
        onScroll={onScroll}
        className="max-h-[46vh] min-h-[10rem] divide-y divide-line/20 overflow-y-auto"
      >
        {node.activity.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">Nothing from this agent yet.</p>
        )}

        {node.activity.map((entry) => (
          <div key={entry.seq} className="px-3 py-1.5 hover:bg-raised/30">
            <div className="flex items-baseline gap-2 font-mono text-[10px]">
              <span className="text-muted/70">{time(entry.ts)}</span>
              <span className={cn("font-medium", TONE[entry.tone ?? "muted"])}>{entry.kind}</span>
              {entry.detail && entry.kind === "message" && (
                <span className="text-muted">{entry.detail}</span>
              )}
            </div>

            <p className={cn(
              "mt-0.5 break-words text-xs",
              entry.kind === "thought" ? "whitespace-pre-wrap text-bright/80" : "text-bright/90",
              entry.kind === "tool" && "font-mono",
            )}>
              {entry.text}
            </p>

            {entry.detail && entry.kind !== "message" && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{entry.detail}</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
