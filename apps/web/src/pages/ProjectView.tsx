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
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread(projectId);
      navigate(`/threads/${thread.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> loading project…
      </p>
    );
  }

  const { project, threads, runs, schedules } = data;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/app" className="text-muted transition-colors hover:text-bright" aria-label="Back to projects">←</Link>
            <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            {project.id} · {project.repoUrl} · {project.defaultBranch}
          </p>
        </div>
        <Button onClick={() => void openThread()} disabled={busy}>
          {busy ? <><Spinner /> opening…</> : "New thread"}
        </Button>
      </header>

      <ProjectTabs projectId={projectId} section={section} />
      {error && <ErrorNote>{error}</ErrorNote>}

      {section === "threads" && <Threads project={project} threads={threads} runs={runs} />}
      {section === "schedules" && (
        <Schedules projectId={projectId} schedules={schedules} reload={load} setError={setError} />
      )}
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
  return (
    <nav className="flex gap-1 border-b border-line/50" aria-label="Project sections">
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={cn(
            "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            section === item.id
              ? "border-accent text-bright"
              : "border-transparent text-muted hover:text-bright",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function Threads({ project, threads, runs }: { project: Project; threads: Thread[]; runs: Run[] }) {
  const runsByThread = new Map<string, Run[]>();
  for (const run of runs) {
    runsByThread.set(run.threadId, [...(runsByThread.get(run.threadId) ?? []), run]);
  }
  const active = runs.filter((run) => ["queued", "running"].includes(run.status)).length;
  const complete = runs.filter((run) => run.status === "completed").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted">Threads</h2>
          <span className="text-xs text-muted">{threads.length}</span>
        </div>
        <div className="space-y-2">
          {threads.length === 0 && <Empty>No threads yet — open one to start work.</Empty>}
          {threads.map((thread) => {
            const threadRuns = runsByThread.get(thread.id) ?? [];
            const latest = threadRuns[0];
            return (
              <Link key={thread.id} to={`/threads/${thread.id}`} className="block">
                <Card className="cursor-pointer p-4 transition-colors hover:border-accent/50">
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-sm">
                      {thread.title ?? latest?.goal ?? <span className="text-muted">New engineering thread</span>}
                    </p>
                    {latest && <Badge status={latest.status} />}
                  </div>
                  <p className="mt-2 font-mono text-xs text-muted">
                    {thread.id} · {threadRuns.length} run{threadRuns.length === 1 ? "" : "s"} · {when(thread.createdAt)}
                  </p>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      <aside className="space-y-4">
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Activity</h2>
          <Card className="space-y-3 p-4 text-sm">
            <Stat label="Runs" value={runs.length} />
            <Stat label="Active" value={active} />
            <Stat label="Completed" value={complete} />
          </Card>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Repository</h2>
          <Card className="p-4 text-sm">
            <p className="break-all font-mono text-xs text-muted">{project.repoUrl}</p>
            <p className="mt-2 text-xs text-muted">
              Agents branch from <span className="font-mono text-bright/80">{project.defaultBranch}</span>.
            </p>
          </Card>
        </section>
      </aside>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex items-center justify-between">
    <dt className="text-muted">{label}</dt>
    <dd className="font-mono text-bright">{value}</dd>
  </div>
);

function ProjectSettings({ project }: { project: Project }) {
  const [integrations, setIntegrations] = useState<ProjectIntegrations | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projectIntegrations(project.id)
      .then(setIntegrations)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [project.id]);

  return (
    <div className="space-y-6">
      {error && <ErrorNote>{error}</ErrorNote>}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">GitHub App</h2>
        <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
          {!integrations ? (
            <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> checking repository access…</p>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {integrations.github.installed ? "Repository access ready" : "Repository needs attention"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {integrations.github.reason ?? "Kapi may create branches and pull requests for this repository."}
                </p>
              </div>
              {integrations.github.installUrl && (
                <a
                  href={integrations.github.installUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink hover:brightness-110"
                >
                  {integrations.github.action === "configure" ? "Configure GitHub" : "Install GitHub App"}
                </a>
              )}
            </>
          )}
        </Card>
      </section>
      <SecretManager scope="project" scopeId={project.id} title="Project secrets" />
    </div>
  );
}

function Schedules(
  { projectId, schedules, reload, setError }: {
    projectId: string;
    schedules: Schedule[];
    reload: () => void;
    setError: (error: string | null) => void;
  },
) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);

  const edit = (schedule: Schedule) => {
    setEditing(schedule);
    setName(schedule.name);
    setCron(schedule.cron);
    setTimezone(schedule.timezone);
    setGoal(schedule.goal);
  };
  const reset = () => {
    setEditing(null);
    setName("");
    setGoal("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, cron, timezone, goal };
      if (editing) await api.updateSchedule(editing.id, body);
      else await api.createSchedule(projectId, body);
      reset();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
      <div>
        <h2 className="mb-3 text-sm font-medium text-muted">
          {editing ? "Edit schedule" : "Schedule a captain"}
        </h2>
        <Card className="p-5">
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Name">
              <Input required value={name} placeholder="Weekday maintenance" onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Cron">
                <Input required className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
              </Field>
              <Field label="Timezone">
                <Input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </Field>
            </div>
            <Field label="Goal">
              <Textarea
                required
                rows={4}
                value={goal}
                placeholder="Review open work and repository health…"
                onChange={(e) => setGoal(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name || !goal}>
                {busy ? <><Spinner /> saving…</> : editing ? "Save schedule" : "Create schedule"}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
              )}
            </div>
          </form>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted">Schedules</h2>
        <div className="space-y-2">
          {schedules.length === 0 && <Empty>No scheduled work yet.</Empty>}
          {schedules.map((schedule) => (
            <Card key={schedule.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium">{schedule.name}</p>
                <Badge status={schedule.enabled ? "running" : "cancelled"} />
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted">{schedule.goal}</p>
              <p className="mt-2 font-mono text-xs text-muted">
                {schedule.cron} · {schedule.timezone}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                next {schedule.nextRunAt ? when(schedule.nextRunAt) : "paused"} · last {schedule.lastStatus ?? "never"}
              </p>
              {schedule.lastError && <p className="mt-1 text-xs text-bad">{schedule.lastError}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => edit(schedule)}>Edit</Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void act(() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }))}
                >
                  {schedule.enabled ? "Pause" : "Resume"}
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void act(() => api.runSchedule(schedule.id))}
                >
                  Run now
                </Button>
                <Button
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void act(() => api.deleteSchedule(schedule.id))}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
