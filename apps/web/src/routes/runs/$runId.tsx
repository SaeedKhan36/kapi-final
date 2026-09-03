import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { useRunStream } from "~/lib/useRunStream.ts";
import type { Message, RunDetail, RunEvent, Task } from "~/lib/types.ts";
import { Badge, Card, RoleChip, Spinner } from "~/components/ui.tsx";
import { TaskGraphView } from "~/components/TaskGraphView.tsx";
import { MessageFeed } from "~/components/MessageFeed.tsx";

export const Route = createFileRoute("/runs/$runId")({ component: RunView });

function RunView() {
  const { runId } = Route.useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [taskStatus, setTaskStatus] = useState<Record<string, string>>({});
  const [runStatus, setRunStatus] = useState<string>("");
  const seen = useRef(new Set<string>());

  const load = useCallback(async () => {
    const d = await api.getRun(runId);
    setDetail(d);
    setRunStatus(d.run.status);
    setMessages(d.messages);
    d.messages.forEach((m) => seen.current.add(m.id));
    setTaskStatus(Object.fromEntries(d.tasks.map((t) => [t.taskId, t.status])));
  }, [runId]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.kind) {
      case "message":
        if (seen.current.has(e.message.id)) return;
        seen.current.add(e.message.id);
        setMessages((prev) => [...prev, e.message]);
        break;
      case "task":
        setTaskStatus((prev) => ({ ...prev, [e.taskId]: e.status }));
        break;
      case "status":
        setRunStatus(e.status);
        // A finished run has final artifacts and branches worth re-reading.
        if (e.status !== "planning") load().catch(() => {});
        break;
      case "plan":
        load().catch(() => {});
        break;
    }
  }, [load]);

  const connected = useRunStream(runId, onEvent);

  const tasks: Task[] = useMemo(
    () => (detail?.tasks ?? []).map((t) => ({ ...t, status: taskStatus[t.taskId] ?? t.status })),
    [detail, taskStatus],
  );

  if (!detail) {
    return <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading run…</div>;
  }

  const { run } = detail;
  const contract = run.plan?.contract;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{run.goal}</h1>
            <Badge status={runStatus || run.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            {run.id} · {run.repoUrl} · {run.sandboxProvider}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${connected ? "bg-ok" : "bg-bad"}`} />
            {connected ? "live" : "reconnecting"}
          </span>
          <span>{run.llmRequests} llm calls</span>
          <span>{run.llmTokens.toLocaleString()} tokens</span>
        </div>
      </header>

      {run.error && (
        <Card className="border-bad/40 bg-bad/10 p-4 text-sm text-bad">{run.error}</Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted">Task graph</h2>
            <TaskGraphView tasks={tasks} />
          </section>

          {contract && (
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted">Shared contract</h2>
              <Card className="space-y-3 p-4 text-sm">
                <p className="text-muted">{contract.summary}</p>

                {contract.endpoints.length > 0 && (
                  <div className="space-y-1">
                    {contract.endpoints.map((e) => (
                      <div key={`${e.method}${e.path}`} className="font-mono text-xs">
                        <span className="text-accent">{e.method}</span>{" "}
                        <span className="text-bright">{e.path}</span>
                        <span className="text-muted"> — {e.description}</span>
                      </div>
                    ))}
                  </div>
                )}

                {contract.tables.length > 0 && (
                  <div className="space-y-1">
                    {contract.tables.map((t) => (
                      <div key={t.name} className="font-mono text-xs">
                        <span className="text-warn">{t.name}</span>
                        <span className="text-muted">({t.columns.map((c) => `${c.name}: ${c.type}`).join(", ")})</span>
                      </div>
                    ))}
                  </div>
                )}

                {contract.conventions.length > 0 && (
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-muted">
                    {contract.conventions.map((c) => <li key={c}>{c}</li>)}
                  </ul>
                )}
              </Card>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-sm font-medium text-muted">Agents</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {detail.agents.map((a) => (
                <Card key={a.agentId} className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-2">
                    <RoleChip role={a.role} />
                    <span className="font-mono text-xs text-muted">{a.agentId}</span>
                  </div>
                  <Badge status={a.status} />
                </Card>
              ))}
              {detail.agents.length === 0 && (
                <Card className="p-4 text-sm text-muted sm:col-span-2">No agents started yet.</Card>
              )}
            </div>
          </section>
        </div>

        <section className="lg:sticky lg:top-20 lg:self-start">
          <h2 className="mb-3 text-sm font-medium text-muted">
            Agent communication <span className="text-xs">({messages.length})</span>
          </h2>
          <MessageFeed messages={messages} />
        </section>
      </div>
    </div>
  );
}
