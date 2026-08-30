import { useCallback, useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { Project, Run, Thread } from "~/lib/types.ts";
import { Link, navigate } from "~/router.tsx";
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from "~/components/ui.tsx";

const when = (ts: string) => new Date(ts).toLocaleString([], {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function ProjectView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ project: Project; threads: Thread[]; runs: Run[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getProject(projectId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId]);

  useEffect(load, [load]);

  const openThread = async () => {
    setBusy(true);
    try {
      const thread = await api.createThread(projectId);
      navigate(`/threads/${thread.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading…</div>;

  const { project, threads, runs } = data;
  const runsByThread = new Map<string, Run[]>();
  for (const run of runs) {
    runsByThread.set(run.threadId, [...(runsByThread.get(run.threadId) ?? []), run]);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 font-mono text-xs text-muted">
            {project.repoUrl} · {project.defaultBranch}
          </p>
        </div>
        <Button onClick={openThread} disabled={busy}>
          {busy ? <><Spinner /> opening…</> : "New thread"}
        </Button>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Threads</h2>
        <div className="space-y-2">
          {threads.length === 0 && <Empty>No threads yet — open one to start work.</Empty>}
          {threads.map((thread) => {
            const threadRuns = runsByThread.get(thread.id) ?? [];
            const latest = threadRuns[0];
            return (
              <Link key={thread.id} to={`/threads/${thread.id}`} className="block">
                <Card className="p-4 transition-colors hover:border-accent/50">
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-sm">
                      {thread.title ?? latest?.goal ?? <span className="text-muted">empty thread</span>}
                    </p>
                    {latest && <Badge status={latest.status} />}
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-muted">
                    {thread.id} · {threadRuns.length} run{threadRuns.length === 1 ? "" : "s"}
                    {" · "}{when(thread.createdAt)}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
