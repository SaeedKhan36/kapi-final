import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { isTerminal, useRun } from "~/lib/useRun.ts";
import type { Message, Project, Thread } from "~/lib/types.ts";
import { Link } from "~/router.tsx";
import { Chat } from "~/components/Chat.tsx";
import { RunPanel } from "~/components/RunPanel.tsx";
import { ErrorNote, Spinner } from "~/components/ui.tsx";
import { cn } from "~/lib/cn.ts";

/**
 * A thread: the conversation on the left, the fleet it produced on the right.
 *
 * The two halves are fed differently on purpose. Turns are REST - there are a
 * handful of them and they are written by the plane. The fleet is the event
 * stream, resumed from a cursor, because a run emits thousands of events and a
 * browser that polled for them would be permanently behind what it is watching.
 */
export function ThreadView({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<{ thread: Thread; project: Project } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"chat" | "fleet">("chat");

  const load = useCallback(async (): Promise<Message[]> => {
    const data = await api.getThread(threadId);
    setThread({ thread: data.thread, project: data.project });
    setMessages(data.messages);
    return data.messages;
  }, [threadId]);

  useEffect(() => {
    setActiveRunId(null);
    load()
      .then((loaded) => {
        const latest = [...loaded].reverse().find((m) => m.runId);
        if (latest?.runId) setActiveRunId(latest.runId);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const run = useRun(activeRunId);

  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!activeRunId || !isTerminal(run.state.status)) return;
    if (settled.current === activeRunId) return;
    settled.current = activeRunId;
    load().catch(() => {});
  }, [activeRunId, run.state.status, load]);

  const send = async (content: string) => {
    setSending(true);
    setError(null);
    try {
      const { message, run: started } = await api.postMessage(threadId, content);
      setMessages((prev) => [...prev, message]);
      settled.current = null;
      setActiveRunId(started.id);
      setMobilePane("fleet");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!thread) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> loading thread…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link
              to={`/projects/${thread.project.id}`}
              className="text-muted transition-colors hover:text-accent"
              aria-label={`Back to ${thread.project.name}`}
            >
              ←
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">
              {thread.thread.title ?? thread.project.name}
            </h1>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            {thread.thread.id} · {thread.project.repoUrl}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-1 lg:hidden" role="tablist" aria-label="Thread view">
        {(["chat", "fleet"] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors",
              mobilePane === pane
                ? "border-accent/50 bg-raised/50 text-bright"
                : "border-line/60 text-muted",
            )}
          >
            {pane}{pane === "fleet" && activeRunId ? " · live" : ""}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:h-[calc(100vh-10rem)] lg:grid-cols-[1.1fr_1fr]">
        <div className={cn("min-h-[32rem] lg:min-h-0", mobilePane !== "chat" && "hidden lg:block")}>
          <Chat
            messages={messages}
            busy={sending}
            error={error}
            activeRunId={activeRunId}
            onSend={send}
            onSelectRun={(runId) => {
              settled.current = null;
              setActiveRunId(runId);
            }}
          />
        </div>

        <div className={cn(
          "min-h-[32rem] overflow-y-auto lg:min-h-0 lg:sticky lg:top-20 lg:self-start",
          mobilePane !== "fleet" && "hidden lg:block",
        )}>
          <RunPanel
            run={run.run}
            state={run.state}
            connected={run.connected}
            loading={run.loading}
            error={run.error}
            onCancel={() => { void run.cancel().catch(() => {}); }}
          />
        </div>
      </div>
    </div>
  );
}
