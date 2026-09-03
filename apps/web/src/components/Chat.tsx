import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "~/lib/cn.ts";
import type { Message } from "~/lib/types.ts";
import { Button, Card, ErrorNote, Spinner, Textarea } from "./ui.tsx";

const time = (ts: string) => new Date(ts).toLocaleString([], {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * The thread.
 *
 * Every user turn is a `POST /api/threads/:id/messages`, which is not a chat
 * completion - it opens a run and queues a root captain. The turn that comes
 * back is written when that captain finishes, so a message here can be minutes
 * of a fleet's work rather than a reply.
 */
export function Chat(
  { messages, busy, error, activeRunId, onSend, onSelectRun }: {
    messages: Message[];
    busy: boolean;
    error: string | null;
    activeRunId: string | null;
    onSend: (content: string) => void;
    onSelectRun: (runId: string) => void;
  },
) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    onSend(content);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h2 className="mb-3 text-sm font-medium text-muted">
        Conversation <span className="text-xs">({messages.length})</span>
      </h2>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="min-h-0 flex-1 divide-y divide-line/30 overflow-y-auto"
        >
          {messages.length === 0 && (
            <p className="p-6 text-center text-sm text-muted">
              Describe what you want built. The captain explores the repository first, then
              delegates it to as many agents as the work needs.
            </p>
          )}

          {messages.map((message) => (
            <Turn
              key={message.id}
              message={message}
              activeRunId={activeRunId}
              onSelectRun={onSelectRun}
            />
          ))}

          {busy && (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted">
              <Spinner /> queueing a captain…
            </div>
          )}
        </div>

        <form onSubmit={submit} className="space-y-2 border-t border-line/40 p-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          <Textarea
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Add a /health endpoint returning JSON status, plus a test covering it"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">enter sends · shift-enter for a new line</span>
            <Button type="submit" disabled={busy || draft.trim().length === 0}>
              {busy ? <><Spinner /> starting…</> : "Send"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Turn(
  { message, activeRunId, onSelectRun }:
  { message: Message; activeRunId: string | null; onSelectRun: (runId: string) => void },
) {
  const user = message.role === "user";
  const system = message.role === "system";

  return (
    <div className={cn(
      "px-3 py-2 hover:bg-raised/30",
      user && "bg-accent/5",
      system && "bg-transparent",
    )}>
      <div className="flex items-baseline gap-2 font-mono text-[10px]">
        <span className={cn(
          "font-medium",
          user ? "text-accent" : system ? "text-muted" : "text-bright",
        )}>
          {user ? "you" : message.role}
        </span>
        <span className="text-muted">{time(message.createdAt)}</span>

        {message.runId && (
          <button
            type="button"
            onClick={() => onSelectRun(message.runId!)}
            className={cn(
              "ml-auto rounded border px-1.5 py-0.5 transition-colors",
              message.runId === activeRunId
                ? "border-accent/50 text-accent"
                : "border-line/60 text-muted hover:border-accent/50 hover:text-accent",
            )}
          >
            {message.runId}
          </button>
        )}
      </div>

      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-bright/90">
        {message.content}
      </p>
    </div>
  );
}
