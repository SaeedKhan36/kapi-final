import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import type { Health, Project } from "~/lib/types.ts";
import { Link, navigate } from "~/router.tsx";
import { Button, Card, Empty, ErrorNote, Field, Input, Spinner } from "~/components/ui.tsx";

export function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => { setProjects([]); setError(String(e.message ?? e)); });
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1.5 text-sm text-muted">
          A project is a repository the fleet may work in. Threads inside it are the
          conversations that start runs.
        </p>

        <Card className="mt-6 p-5">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name">
              <Input required value={name} placeholder="demo"
                onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Repository" hint="https git URL the agents clone">
              <Input required type="url" value={repoUrl}
                placeholder="https://github.com/you/your-repo.git"
                onChange={(e) => setRepoUrl(e.target.value)} />
            </Field>
            <Field label="Default branch">
              <Input required value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)} />
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" disabled={busy || !name || !repoUrl} className="w-full">
              {busy ? <><Spinner /> creating…</> : "Create project"}
            </Button>
          </form>
        </Card>

        {health && <PlaneStatus health={health} />}
      </div>

      <div>
        <h2 className="text-sm font-medium text-muted">Your projects</h2>
        <div className="mt-3 space-y-2">
          {projects === null && (
            <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading…</div>
          )}
          {projects?.length === 0 && <Empty>No projects yet.</Empty>}
          {projects?.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`} className="block">
              <Card className="p-4 transition-colors hover:border-accent/50">
                <p className="text-sm font-medium">{project.name}</p>
                <p className="mt-1 truncate font-mono text-xs text-muted">{project.repoUrl}</p>
                <p className="mt-1 font-mono text-[10px] text-muted">
                  {project.id} · {project.defaultBranch}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The plane says out loud when it is not authenticating anything. Repeating it
 * here rather than hiding it: an unauthenticated mode indistinguishable from a
 * real one is how a dev shortcut ends up in production.
 */
function PlaneStatus({ health }: { health: Health }) {
  const warn = health.auth === "dev" || health.vault.startsWith("NOT");
  return (
    <Card className={`mt-4 p-4 text-xs ${warn ? "border-warn/40 bg-warn/5" : ""}`}>
      <div className="grid grid-cols-2 gap-y-1 font-mono text-muted">
        <span>database</span><span className="text-bright/80">{health.database}</span>
        <span>auth</span>
        <span className={health.auth === "dev" ? "text-warn" : "text-bright/80"}>
          {health.auth}{health.auth === "dev" && " — nothing is authenticated"}
        </span>
        <span>vault</span>
        <span className={health.vault.startsWith("NOT") ? "text-warn" : "text-bright/80"}>
          {health.vault}
        </span>
        <span>vms</span><span className="text-bright/80">{health.vmProvider}</span>
        <span>queue depth</span><span className="text-bright/80">{health.queueDepth}</span>
      </div>
    </Card>
  );
}
