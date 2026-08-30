import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { isTerminal, useRun } from "~/lib/useRun.ts";
import type { Message, Project, Thread } from "~/lib/types.ts";
import { Link } from "~/router.tsx";
import { Chat } from "~/components/Chat.tsx";
import { RunPanel } from "~/components/RunPanel.tsx";
import { ErrorNote, Spinner } from "~/components/ui.tsx";

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
        // Open on the newest run in the thread; that is what the user was
        // watching when they last had this page open.
        const latest = [...loaded].reverse().find((m) => m.runId);
        if (latest?.runId) setActiveRunId(latest.runId);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const run = useRun(activeRunId);

  // A captain's closing turn is written when its job completes, so the thread
  // is re-read exactly once per run that ends rather than polled throughout.
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!thread) return <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading thread…</div>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/projects/${thread.project.id}`} className="text-sm font-medium hover:text-accent">
          {thread.project.name}
        </Link>
        <span className="text-muted">/</span>
        <span className="text-sm text-muted">{thread.thread.title ?? "thread"}</span>
        <span className="font-mono text-[10px] text-muted">{thread.thread.id}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">{thread.project.repoUrl}</span>
      </header>

      <div className="grid gap-6 lg:h-[calc(100vh-11rem)] lg:grid-cols-[1fr_1.15fr]">
        <Chat
          messages={messages}
          busy={sending}
          error={error}
          activeRunId={activeRunId}
          onSend={send}
          onSelectRun={(runId) => { settled.current = null; setActiveRunId(runId); }}
        />

        <div className="min-h-0 overflow-y-auto pr-1">
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
