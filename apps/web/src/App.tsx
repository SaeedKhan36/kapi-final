import { useEffect, useState, type ReactNode } from "react";
import { Link, match, usePath } from "./router.tsx";
import { Projects } from "./pages/Projects.tsx";
import { ProjectView } from "./pages/ProjectView.tsx";
import { ThreadView } from "./pages/ThreadView.tsx";
import { api, ApiError } from "./lib/api.ts";
import type { Principal } from "./lib/types.ts";
import { Button, Card, Spinner } from "./components/ui.tsx";

export function App() {
  return <AuthGate><Workspace /></AuthGate>;
}

function Workspace() {
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
          <button className="ml-auto text-xs text-muted hover:text-bright" onClick={() => {
            void api.logout().finally(() => location.reload());
          }}>Sign out</button>
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

function AuthGate({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.me().then(setPrincipal).catch((err) => {
      if (err instanceof ApiError && err.status === 401) setPrincipal(null);
      else setError(err instanceof Error ? err.message : String(err));
    });
  }, []);
  if (principal === undefined && !error) return <div className="grid min-h-screen place-items-center text-sm text-muted"><Spinner /></div>;
  if (!principal) return (
    <div className="grid min-h-screen place-items-center px-6">
      <Card className="max-w-md p-8 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-accent font-bold text-ink">k</span>
        <h1 className="mt-4 text-xl font-semibold">Sign in to kapi</h1>
        <p className="mt-2 text-sm text-muted">Your projects, run history, and live agent streams are private to your account.</p>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <Button className="mt-5 w-full" onClick={() => { location.href = api.loginUrl(); }}>Continue with AuthKit</Button>
      </Card>
    </div>
  );
  return <>{children}</>;
}

const NotFound = ({ path }: { path: string }) => (
  <div className="text-sm text-muted">
    Nothing at <span className="font-mono text-bright/80">{path}</span>.{" "}
    <Link to="/" className="text-accent hover:underline">Go back</Link>.
  </div>
);
