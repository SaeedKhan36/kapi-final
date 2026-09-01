import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import type { Health, Project, Setup } from "~/lib/types.ts";
import { Link, navigate } from "~/router.tsx";
import { Button, Card, Empty, ErrorNote, Field, Input, Spinner } from "~/components/ui.tsx";

export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => { setProjects([]); setError(String(e.message ?? e)); });
    api.health().then(setHealth).catch(() => setHealth(null));
    api.setup().then(setSetup).catch(() => setSetup(null));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const project = await api.createProject({ name, repoUrl, defaultBranch });
      navigate(`/projects/${project.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-8">
      <section className="grid items-end gap-8 lg:grid-cols-[1.15fr_.85fr]">
        <div>
          <p className="eyebrow">Engineering command center</p>
          <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
            Give the goal to a captain.<br /><span className="text-muted">Watch a fleet deliver it.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
            Each project is a repository. Each thread is a durable conversation, with Build and Review agents appearing live as the Captain delegates.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Metric value={String(projects?.length ?? "—")} label="projects" />
          <Metric value={String(health?.queueDepth ?? "—")} label="queued" />
          <Metric value={health?.vmProvider ?? "—"} label="runtime" />
        </div>
      </section>

      {!setup?.codex.connected && (
        <Card className="flex flex-col gap-4 border-warn/35 bg-warn/5 p-4 sm:flex-row sm:items-center">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-warn/30 bg-warn/10 text-warn">!</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Connect Codex before starting work</p>
            <p className="mt-1 text-xs text-muted">Your subscription powers every Captain, Build and Review model call.</p>
          </div>
          <Link to="/setup" className="text-sm font-medium text-warn hover:underline">Open setup →</Link>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[.8fr_1.2fr]">
        <Card className="overflow-hidden lg:sticky lg:top-20 lg:self-start">
          <div className="border-b border-line/50 px-5 py-4">
            <p className="eyebrow">New workspace</p>
            <h2 className="mt-1 text-lg font-semibold">Connect a repository</h2>
          </div>
          <form onSubmit={submit} className="space-y-4 p-5">
            <Field label="Project name"><Input required value={name} placeholder="Payments API" onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Repository" hint="GitHub HTTPS URL"><Input required type="url" value={repoUrl} placeholder="https://github.com/you/repo.git" onChange={(e) => setRepoUrl(e.target.value)} /></Field>
            <Field label="Default branch"><Input required value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy || !name || !repoUrl} className="w-full">
              {busy ? <><Spinner /> creating workspace…</> : "Create workspace"}
            </Button>
          </form>
        </Card>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <div><p className="eyebrow">Repositories</p><h2 className="mt-1 text-lg font-semibold">Your projects</h2></div>
            <span className="font-mono text-[10px] text-muted">{projects?.length ?? 0} total</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {projects === null && <Card className="col-span-full flex items-center gap-2 p-6 text-sm text-muted"><Spinner /> loading workspaces…</Card>}
            {projects?.length === 0 && <div className="col-span-full"><Empty>No projects yet. Connect your first repository.</Empty></div>}
            {projects?.map((project, index) => (
              <Link key={project.id} to={`/projects/${project.id}`} className="group block">
                <Card className="h-full p-5 transition-all group-hover:-translate-y-0.5 group-hover:border-accent/45 group-hover:bg-raised/40">
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line/60 bg-ink/50 font-mono text-xs text-accent">{String(index + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{project.name}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted">{project.repoUrl.replace(/^https:\/\/github\.com\//, "")}</p>
                    </div>
                    <span className="text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent">→</span>
                  </div>
                  <div className="mt-5 flex items-center justify-between border-t border-line/40 pt-3 font-mono text-[10px] text-muted">
                    <span>{project.defaultBranch}</span><span>{project.id}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function Metric({ value, label }: { value: string; label: string }) {
  return <Card className="px-3 py-3 text-center"><p className="truncate font-mono text-sm text-bright">{value}</p><p className="mt-1 text-[10px] uppercase tracking-wider text-muted">{label}</p></Card>;
}
