import { Link, match, usePath } from "./router.tsx";
import { Projects } from "./pages/Projects.tsx";
import { ProjectView } from "./pages/ProjectView.tsx";
import { ThreadView } from "./pages/ThreadView.tsx";

export function App() {
  const path = usePath();

  const project = match(path, "/projects/:id");
  const thread = match(path, "/threads/:id");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line/50 bg-ink/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-lg bg-accent font-bold text-ink">k</span>
            <span className="font-semibold tracking-tight">kapi</span>
          </Link>
          <span className="text-xs text-muted">your autonomous engineering team</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {thread ? <ThreadView key={thread.id} threadId={thread.id!} />
          : project ? <ProjectView key={project.id} projectId={project.id!} />
          : match(path, "/") ? <Projects />
          : <NotFound path={path} />}
      </main>
    </div>
  );
}

const NotFound = ({ path }: { path: string }) => (
  <div className="text-sm text-muted">
    Nothing at <span className="font-mono text-bright/80">{path}</span>.{" "}
    <Link to="/" className="text-accent hover:underline">Go back</Link>.
  </div>
);
