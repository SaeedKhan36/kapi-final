import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "~/lib/api.ts";
import type { Project, ProjectIntegrations, Run, Schedule, Thread } from "~/lib/types.ts";
import { Link, navigate } from "~/router.tsx";
import { SecretManager } from "~/components/SecretManager.tsx";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Spinner, Textarea } from "~/components/ui.tsx";
import { cn } from "~/lib/cn.ts";

export type ProjectSection = "threads" | "schedules" | "settings";

const when = (ts: string) => new Date(ts).toLocaleString([], {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function ProjectView({ projectId, section }: { projectId: string; section: ProjectSection }) {
  const [data, setData] = useState<{ project: Project; threads: Thread[]; runs: Run[]; schedules: Schedule[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getProject(projectId), api.listSchedules(projectId)])
      .then(([project, schedules]) => { setData({ ...project, schedules }); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId]);
  useEffect(load, [load]);

  const openThread = async () => {
    setBusy(true); setError(null);
    try { const thread = await api.createThread(projectId); navigate(`/threads/${thread.id}`); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading workspace…</p>;
  const { project, threads, runs, schedules } = data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-4">
        <Link to="/" className="mt-1 text-muted transition-colors hover:text-accent" aria-label="Back to workspaces">←</Link>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Project workspace</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 truncate font-mono text-xs text-muted">{project.repoUrl} · {project.defaultBranch}</p>
        </div>
        <Button onClick={() => void openThread()} disabled={busy}>{busy ? <><Spinner /> opening…</> : "+ New thread"}</Button>
      </header>

      <ProjectTabs projectId={projectId} section={section} />
      {error && <ErrorNote>{error}</ErrorNote>}

      {section === "threads" && <Threads project={project} threads={threads} runs={runs} />}
      {section === "schedules" && <Schedules projectId={projectId} schedules={schedules} reload={load} setError={setError} />}
      {section === "settings" && <ProjectSettings project={project} />}
    </div>
  );
}

function ProjectTabs({ projectId, section }: { projectId: string; section: ProjectSection }) {
  const items: Array<{ id: ProjectSection; label: string; to: string }> = [
    { id: "threads", label: "Threads", to: `/projects/${projectId}` },
    { id: "schedules", label: "Schedules", to: `/projects/${projectId}/schedules` },
    { id: "settings", label: "Settings", to: `/projects/${projectId}/settings` },
  ];
  return <nav className="flex gap-1 overflow-x-auto border-b border-line/50" aria-label="Project sections">
    {items.map((item) => <Link key={item.id} to={item.to} className={cn(
      "border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
      section === item.id ? "border-accent text-bright" : "border-transparent text-muted hover:text-bright",
    )}>{item.label}</Link>)}
  </nav>;
}

function Threads({ project, threads, runs }: { project: Project; threads: Thread[]; runs: Run[] }) {
  const runsByThread = new Map<string, Run[]>();
  for (const run of runs) runsByThread.set(run.threadId, [...(runsByThread.get(run.threadId) ?? []), run]);
  const active = runs.filter((run) => ["queued", "running"].includes(run.status)).length;
  const complete = runs.filter((run) => run.status === "completed").length;

  return <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
    <section>
      <div className="mb-3 flex items-end justify-between"><div><p className="eyebrow">Conversation history</p><h2 className="mt-1 text-lg font-semibold">Engineering threads</h2></div><span className="text-xs text-muted">{threads.length} total</span></div>
      <div className="grid gap-3 md:grid-cols-2">
        {threads.length === 0 && <div className="md:col-span-2"><Empty>No threads yet — open one to start work.</Empty></div>}
        {threads.map((thread) => {
          const threadRuns = runsByThread.get(thread.id) ?? [];
          const latest = threadRuns[0];
          return <Link key={thread.id} to={`/threads/${thread.id}`} className="group block">
            <Card className="h-full p-4 transition-all group-hover:border-accent/45 group-hover:bg-raised/35">
              <div className="flex items-start justify-between gap-3">
                <p className="line-clamp-2 text-sm font-medium">{thread.title ?? latest?.goal ?? <span className="text-muted">New engineering thread</span>}</p>
                {latest && <Badge status={latest.status} />}
              </div>
              {latest?.goal && thread.title && <p className="mt-2 line-clamp-2 text-xs text-muted">{latest.goal}</p>}
              <div className="mt-4 flex items-center justify-between border-t border-line/40 pt-3 font-mono text-[10px] text-muted">
                <span>{threadRuns.length} run{threadRuns.length === 1 ? "" : "s"}</span><span>{when(thread.createdAt)}</span>
              </div>
            </Card>
          </Link>;
        })}
      </div>
    </section>
    <aside className="space-y-3">
      <Card className="p-4"><p className="eyebrow">Activity</p><dl className="mt-4 space-y-3 text-sm"><Stat label="Runs" value={runs.length} /><Stat label="Active" value={active} /><Stat label="Completed" value={complete} /></dl></Card>
      <Card className="p-4"><p className="text-xs font-medium text-muted">Repository</p><p className="mt-2 break-all font-mono text-[11px] leading-5">{project.repoUrl}</p><p className="mt-3 text-xs text-muted">Agents branch from <span className="font-mono text-bright/80">{project.defaultBranch}</span>.</p></Card>
    </aside>
  </div>;
}

const Stat = ({ label, value }: { label: string; value: ReactNode }) => <div className="flex items-center justify-between"><dt className="text-muted">{label}</dt><dd className="font-mono text-bright">{value}</dd></div>;

function ProjectSettings({ project }: { project: Project }) {
  const [integrations, setIntegrations] = useState<ProjectIntegrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.projectIntegrations(project.id).then(setIntegrations).catch((err) => setError(err instanceof Error ? err.message : String(err))); }, [project.id]);
  return <div className="space-y-5">
    {error && <ErrorNote>{error}</ErrorNote>}
    <Card className="overflow-hidden">
      <div className="border-b border-line/50 px-5 py-4"><p className="eyebrow">Source control</p><h2 className="mt-1 text-lg font-semibold">GitHub App</h2></div>
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        {!integrations ? <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> checking repository access…</p> : <>
          <span className={`grid size-10 shrink-0 place-items-center rounded-lg border ${integrations.github.installed ? "border-ok/30 bg-ok/10 text-ok" : "border-warn/30 bg-warn/10 text-warn"}`}>{integrations.github.installed ? "✓" : "!"}</span>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{integrations.github.installed ? "Repository access ready" : "Repository needs attention"}</p><p className="mt-1 text-xs leading-5 text-muted">{integrations.github.reason ?? "Kapi may create branches and pull requests for this repository."}</p></div>
          {integrations.github.installUrl && <a href={integrations.github.installUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-accent px-4 py-2 text-center text-sm font-medium text-ink hover:brightness-110">{integrations.github.action === "configure" ? "Configure GitHub" : "Install GitHub App"}</a>}
        </>}
      </div>
    </Card>
    <SecretManager scope="project" scopeId={project.id} title="Project secrets" />
  </div>;
}

function Schedules({ projectId, schedules, reload, setError }: { projectId: string; schedules: Schedule[]; reload: () => void; setError: (error: string | null) => void }) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const edit = (schedule: Schedule) => { setEditing(schedule); setName(schedule.name); setCron(schedule.cron); setTimezone(schedule.timezone); setGoal(schedule.goal); };
  const reset = () => { setEditing(null); setName(""); setGoal(""); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { const body = { name, cron, timezone, goal }; if (editing) await api.updateSchedule(editing.id, body); else await api.createSchedule(projectId, body); reset(); reload(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); reload(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  return <div className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
    <Card className="self-start overflow-hidden"><div className="border-b border-line/50 px-5 py-4"><p className="eyebrow">Automation</p><h2 className="mt-1 text-lg font-semibold">{editing ? "Edit schedule" : "Schedule a captain"}</h2></div><form className="space-y-3 p-5" onSubmit={submit}><Field label="Name"><Input required value={name} placeholder="Weekday maintenance" onChange={(e) => setName(e.target.value)} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Cron"><Input required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} /></Field><Field label="Timezone"><Input required value={timezone} onChange={(e) => setTimezone(e.target.value)} /></Field></div><Field label="Goal"><Textarea required rows={4} value={goal} placeholder="Review open work and repository health…" onChange={(e) => setGoal(e.target.value)} /></Field><div className="flex gap-2"><Button type="submit" disabled={busy || !name || !goal}>{busy ? <><Spinner /> saving…</> : editing ? "Save schedule" : "Create schedule"}</Button>{editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}</div></form></Card>
    <section><div className="mb-3"><p className="eyebrow">Recurring work</p><h2 className="mt-1 text-lg font-semibold">Schedules</h2></div><div className="space-y-3">{schedules.length === 0 && <Empty>No scheduled work yet.</Empty>}{schedules.map((schedule) => <Card key={schedule.id} className="p-4"><div className="flex items-start gap-3"><span className={`mt-1 size-2 rounded-full ${schedule.enabled ? "bg-ok" : "bg-muted"}`} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-medium">{schedule.name}</p><Badge status={schedule.enabled ? "running" : "cancelled"} /></div><p className="mt-1 line-clamp-2 text-xs text-muted">{schedule.goal}</p><p className="mt-3 font-mono text-[10px] text-muted">{schedule.cron} · {schedule.timezone}</p><p className="mt-1 text-[11px] text-muted">next {schedule.nextRunAt ? when(schedule.nextRunAt) : "paused"} · last {schedule.lastStatus ?? "never"}</p>{schedule.lastError && <p className="mt-1 text-xs text-bad">{schedule.lastError}</p>}</div></div><div className="mt-3 flex flex-wrap gap-2 border-t border-line/40 pt-3"><Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => edit(schedule)}>Edit</Button><Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>{schedule.enabled ? "Pause" : "Resume"}</Button><Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => api.runSchedule(schedule.id))}>Run now</Button><Button variant="danger" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => api.deleteSchedule(schedule.id))}>Delete</Button></div></Card>)}</div></section>
  </div>;
}
