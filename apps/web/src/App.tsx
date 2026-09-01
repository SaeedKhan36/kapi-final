import { useEffect, useState, type ReactNode } from "react";
import { Link, match, usePath } from "./router.tsx";
import { Projects } from "./pages/Projects.tsx";
import { ProjectView } from "./pages/ProjectView.tsx";
import { ThreadView } from "./pages/ThreadView.tsx";
import { Setup } from "./pages/Setup.tsx";
import { api, ApiError } from "./lib/api.ts";
import type { Principal, Setup as SetupState } from "./lib/types.ts";
import { Button, Card, Spinner } from "./components/ui.tsx";
import { cn } from "./lib/cn.ts";

export function App() {
  return <AuthGate>{(principal) => <Workspace principal={principal} />}</AuthGate>;
}

function Workspace({ principal }: { principal: Principal }) {
  const path = usePath();
  const [setup, setSetup] = useState<SetupState | null>(null);
  useEffect(() => { api.setup().then(setSetup).catch(() => {}); }, [path]);

  const thread = match(path, "/threads/:id");
  const projectSettings = match(path, "/projects/:id/settings");
  const projectSchedules = match(path, "/projects/:id/schedules");
  const project = match(path, "/projects/:id");

  let content: ReactNode;
  if (thread) content = <ThreadView key={thread.id} threadId={thread.id!} />;
  else if (projectSettings) content = <ProjectView key={projectSettings.id} projectId={projectSettings.id!} section="settings" />;
  else if (projectSchedules) content = <ProjectView key={projectSchedules.id} projectId={projectSchedules.id!} section="schedules" />;
  else if (project) content = <ProjectView key={project.id} projectId={project.id!} section="threads" />;
  else if (match(path, "/setup")) content = <Setup principal={principal} />;
  else if (match(path, "/")) content = <Projects />;
  else content = <NotFound path={path} />;

  return (
    <div className="min-h-screen bg-grid">
      <header className="sticky top-0 z-30 border-b border-line/50 bg-ink/88 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-5 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5" aria-label="Kapi home">
            <span className="grid size-8 place-items-center rounded-lg bg-accent font-bold text-ink shadow-[0_0_24px_color-mix(in_oklab,var(--color-accent)_28%,transparent)]">k</span>
            <span className="font-semibold tracking-tight">kapi</span>
          </Link>
          <nav className="flex items-center gap-0.5 sm:gap-1" aria-label="Primary navigation">
            <NavLink to="/" active={path === "/" || path.startsWith("/projects/") || path.startsWith("/threads/")}>Workspaces</NavLink>
            <NavLink to="/setup" active={path === "/setup"}>Setup</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Link to="/setup" className="hidden items-center gap-2 rounded-full border border-line/60 bg-surface/60 px-3 py-1.5 text-[11px] text-muted md:flex">
              <span className={cn("size-1.5 rounded-full", setup?.codex.connected ? "bg-ok" : "bg-warn")} />
              {setup?.codex.connected ? "fleet ready" : "setup needed"}
            </Link>
            <span className="hidden max-w-44 truncate text-xs text-muted lg:block">{principal.name ?? principal.email ?? "account"}</span>
            <button className="text-xs text-muted transition-colors hover:text-bright" onClick={() => {
              void api.logout().finally(() => location.reload());
            }}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:py-8">{content}</main>
    </div>
  );
}

function NavLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return <Link to={to} className={cn(
    "rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors sm:px-3 sm:text-xs",
    active ? "bg-raised/80 text-bright" : "text-muted hover:bg-raised/40 hover:text-bright",
  )}>{children}</Link>;
}

function AuthGate({ children }: { children: (principal: Principal) => ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.me().then(setPrincipal).catch((err) => {
      if (err instanceof ApiError && err.status === 401) setPrincipal(null);
      else setError(err instanceof Error ? err.message : String(err));
    });
  }, []);
  if (principal === undefined && !error) return <div className="grid min-h-screen place-items-center text-sm text-muted"><Spinner className="size-5" /></div>;
  if (!principal) return (
    <div className="grid min-h-screen place-items-center bg-grid px-6">
      <Card className="w-full max-w-md p-8 text-center shadow-2xl">
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-accent text-lg font-bold text-ink">k</span>
        <p className="eyebrow mt-6">Autonomous engineering team</p>
        <h1 className="mt-2 text-2xl font-semibold">Sign in to kapi</h1>
        <p className="mt-3 text-sm leading-6 text-muted">Your repositories, run history and live fleet traces stay private to your account.</p>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <Button className="mt-6 w-full" onClick={() => { location.href = api.loginUrl(); }}>Continue with AuthKit</Button>
      </Card>
    </div>
  );
  return <>{children(principal)}</>;
}

const NotFound = ({ path }: { path: string }) => (
  <Card className="mx-auto max-w-lg p-8 text-center">
    <p className="eyebrow">404</p>
    <h1 className="mt-2 text-xl font-semibold">Nothing here</h1>
    <p className="mt-2 text-sm text-muted">No Kapi workspace exists at <span className="font-mono">{path}</span>.</p>
    <Link to="/" className="mt-5 inline-block text-sm text-accent hover:underline">Return to workspaces</Link>
  </Card>
);
