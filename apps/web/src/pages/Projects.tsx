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
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({ name, repoUrl, defaultBranch });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Delegate to your agent team</h1>
        <p className="mt-1.5 text-sm text-muted">
          Connect a repository, open a thread, and a captain plans the work across specialist
          workers — each in its own sandbox on its own branch.
        </p>

        <Card className="mt-6 p-5">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Project name">
              <Input
                required
                value={name}
                placeholder="Payments API"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Repository" hint="https git URL the agents will clone">
              <Input
                required
                type="url"
                value={repoUrl}
                placeholder="https://github.com/you/your-repo.git"
                onChange={(e) => setRepoUrl(e.target.value)}
              />
            </Field>
            <Field label="Default branch">
              <Input
                required
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
              />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy || !name || !repoUrl} className="w-full">
              {busy ? <><Spinner /> creating…</> : "Create project"}
            </Button>
          </form>
        </Card>

        {!setup?.codex.connected && (
          <p className="mt-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
            Connect Codex before starting work.{" "}
            <Link to="/setup" className="font-medium underline">Open setup</Link>
          </p>
        )}

        {health && (
          <p className="mt-3 text-xs text-muted">
            queue {health.queueDepth} · runtime {health.vmProvider}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted">Projects</h2>
          <span className="font-mono text-xs text-muted">{projects?.length ?? 0}</span>
        </div>

        <div className="mt-3 space-y-2">
          {projects === null && (
            <Card className="flex items-center gap-2 p-6 text-sm text-muted">
              <Spinner /> loading…
            </Card>
          )}
          {projects?.length === 0 && <Empty>No projects yet.</Empty>}
          {projects?.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`} className="block">
              <Card className="cursor-pointer p-4 transition-colors hover:border-accent/50">
                <div className="flex items-start justify-between gap-3">
                  <p className="truncate text-sm font-medium">{project.name}</p>
                  <span className="font-mono text-[10px] text-muted">{project.defaultBranch}</span>
                </div>
                <p className="mt-2 truncate font-mono text-xs text-muted">
                  {project.id} · {project.repoUrl.replace(/^https:\/\/github\.com\//, "")}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
