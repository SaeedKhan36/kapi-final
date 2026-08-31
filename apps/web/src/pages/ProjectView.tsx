import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import type { Project, Run, Schedule, Thread } from "~/lib/types.ts";
import { Link, navigate } from "~/router.tsx";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Spinner, Textarea } from "~/components/ui.tsx";

const when = (ts: string) => new Date(ts).toLocaleString([], {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function ProjectView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ project: Project; threads: Thread[]; runs: Run[]; schedules: Schedule[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getProject(projectId), api.listSchedules(projectId)])
      .then(([project, schedules]) => setData({ ...project, schedules }))
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

  const { project, threads, runs, schedules } = data;
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

      <Schedules projectId={projectId} schedules={schedules} reload={load} setError={setError} />

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

function Schedules({ projectId, schedules, reload, setError }: {
  projectId: string; schedules: Schedule[]; reload: () => void;
  setError: (error: string | null) => void;
}) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);

  const edit = (schedule: Schedule) => {
    setEditing(schedule); setName(schedule.name); setCron(schedule.cron);
    setTimezone(schedule.timezone); setGoal(schedule.goal);
  };
  const reset = () => { setEditing(null); setName(""); setGoal(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const body = { name, cron, timezone, goal };
      if (editing) await api.updateSchedule(editing.id, body);
      else await api.createSchedule(projectId, body);
      reset(); reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); reload(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-muted">Schedules</h2>
      <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <Card className="p-4">
          <form className="space-y-3" onSubmit={submit}>
            <Field label={editing ? "Edit schedule" : "New schedule"}>
              <Input required value={name} placeholder="Weekday maintenance" onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cron"><Input required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} /></Field>
              <Field label="Timezone"><Input required value={timezone} onChange={(e) => setTimezone(e.target.value)} /></Field>
            </div>
            <Field label="Goal"><Textarea required rows={3} value={goal} placeholder="Review open work and…" onChange={(e) => setGoal(e.target.value)} /></Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name || !goal}>{busy ? <><Spinner /> saving…</> : editing ? "Save" : "Create"}</Button>
              {editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}
            </div>
          </form>
        </Card>
        <div className="space-y-2">
          {schedules.length === 0 && <Empty>No scheduled work yet.</Empty>}
          {schedules.map((schedule) => (
            <Card key={schedule.id} className="p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><p className="text-sm font-medium">{schedule.name}</p><Badge status={schedule.enabled ? "running" : "cancelled"} /></div>
                  <p className="mt-1 truncate text-xs text-muted">{schedule.goal}</p>
                  <p className="mt-2 font-mono text-[10px] text-muted">{schedule.cron} · {schedule.timezone}</p>
                  <p className="mt-1 text-[11px] text-muted">next {schedule.nextRunAt ? when(schedule.nextRunAt) : "paused"} · last {schedule.lastStatus ?? "never"}</p>
                  {schedule.lastError && <p className="mt-1 text-xs text-bad">{schedule.lastError}</p>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => edit(schedule)}>Edit</Button>
                <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>{schedule.enabled ? "Pause" : "Resume"}</Button>
                <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api.runSchedule(schedule.id))}>Run now</Button>
                <Button variant="danger" className="px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api.deleteSchedule(schedule.id))}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
