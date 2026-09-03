import { useEffect, useRef } from "react";
import type { Message } from "~/lib/types.ts";
import { Card } from "./ui.tsx";
import { cn } from "~/lib/cn.ts";

const TYPE_TONE: Record<string, string> = {
  TASK_COMPLETED: "text-ok",
  REVIEW_APPROVED: "text-ok",
  CODE_REVIEW_REQUESTED: "text-accent",
  API_READY: "text-ok",
  SCHEMA_READY: "text-ok",
  PLAN_READY: "text-accent",
  TASK_ASSIGNED: "text-accent",
  TASK_STARTED: "text-accent",
  QUERY: "text-warn",
  QUERY_RESPONSE: "text-warn",
  NEEDS_HELP: "text-warn",
  BLOCKED: "text-warn",
  TASK_FAILED: "text-bad",
  TEST_FAILED: "text-bad",
  CHANGE_REQUESTED: "text-bad",
  LOG: "text-muted",
};

const shortAgent = (id: string) => id.replace(/^worker:/, "");

export function MessageFeed({ messages }: { messages: Message[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <Card className="overflow-hidden">
      <div ref={ref} onScroll={onScroll} className="max-h-[70vh] divide-y divide-line/30 overflow-y-auto">
        {messages.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">No messages yet.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="px-3 py-2 hover:bg-raised/30">
            <div className="flex items-center gap-1.5 font-mono text-[10px]">
              <span className="text-bright">{shortAgent(m.from)}</span>
              <span className="text-muted">→</span>
              <span className="text-muted">{shortAgent(m.to)}</span>
              <span className={cn("ml-auto font-medium", TYPE_TONE[m.type] ?? "text-muted")}>{m.type}</span>
            </div>
            <p className={cn(
              "mt-0.5 whitespace-pre-wrap break-words text-xs",
              m.type === "LOG" ? "font-mono text-[11px] text-muted" : "text-bright/90",
            )}>
              {m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content}
            </p>
            {m.files && m.files.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.files.slice(0, 8).map((f) => (
                  <span key={f.path} className="rounded bg-raised/60 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {f.path}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
