import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { Run } from "~/lib/types.ts";
import { Logo } from "~/components/Logo.tsx";
import { Badge, Button, Card, Input, Spinner, Textarea } from "~/components/ui.tsx";

export const Route = createFileRoute("/app")({ component: AppHome });

function AppHome() {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [maxTasks, setMaxTasks] = useState(4);
  const [concurrency, setConcurrency] = useState(3);
  const [runs, setRuns] = useState<Run[]>([]);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRuns().then(setRuns).catch(() => {});
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.createRun({ goal, repoUrl, maxTasks, maxConcurrency: concurrency });
      navigate({ to: "/runs/$runId", params: { runId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="shell py-8">
        <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Delegate to your agent team</h1>
            <p className="mt-1.5 text-sm text-muted">
              A master agent plans the work and splits it across specialist workers, each in its own
              sandbox on its own branch.
            </p>

            <Card className="mt-6 p-5">
              <form onSubmit={submit} className="space-y-4">
                <Field label="Repository" hint="https git URL the agents will clone">
                  <Input
                    required
                    placeholder="https://github.com/you/your-repo.git"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                </Field>

                <Field label="Goal" hint="what the team should build">
                  <Textarea
                    required
                    rows={4}
                    placeholder="Add a /health endpoint returning JSON status, plus a test covering it"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Max tasks" hint="plan size cap">
                    <Input type="number" min={1} max={12} value={maxTasks}
                      onChange={(e) => setMaxTasks(Number(e.target.value))} />
                  </Field>
                  <Field label="Parallel workers" hint="concurrent sandboxes">
                    <Input type="number" min={1} max={8} value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))} />
                  </Field>
                </div>

                {error && (
                  <p className="rounded-xl border-[1.5px] border-line bg-[#fee2e2] px-3 py-2 text-sm text-bad">{error}</p>
                )}

                <Button type="submit" disabled={busy || !goal || !repoUrl} className="w-full">
                  {busy ? <><Spinner /> starting…</> : "Start run"}
                </Button>
              </form>
            </Card>

            {health && !health.llmConfigured && (
              <p className="mt-4 rounded-xl border-[1.5px] border-line bg-[#fef08a] px-3 py-2 text-sm text-warn">
                No LLM key configured. Set <code className="font-mono">GEMINI_API_KEY</code> in
                {" "}<code className="font-mono">.env</code> — free at aistudio.google.com/apikey.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-muted">Recent runs</h2>
              {health && (
                <span className="text-xs text-dim">
                  {health.provider} · {health.pushEnabled ? "push on" : "push off"}
                </span>
              )}
            </div>

            <div className="mt-3 space-y-2">
              {runs.length === 0 && (
                <Card className="p-6 text-center text-sm text-muted">No runs yet.</Card>
              )}
              {[...runs].reverse().map((run, i) => (
                <Card
                  key={run.id}
                  className={`cursor-pointer p-4 transition-transform hover:-translate-y-0.5 ${
                    i % 3 === 0 ? "bg-[#fff8e7]" : i % 3 === 1 ? "bg-[#e0f2fe]" : "bg-white"
                  }`}
                  onClick={() => navigate({ to: "/runs/$runId", params: { runId: run.id } })}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-sm font-medium">{run.goal}</p>
                    <Badge status={run.status} />
                  </div>
                  <p className="mt-2 font-mono text-xs text-dim">
                    {run.id} · {run.plan?.tasks.length ?? 0} tasks · {run.llmRequests} llm calls
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/15 bg-[#f7f4ec]/85 backdrop-blur-xl">
      <div className="shell flex h-14 items-center gap-4">
        <Link to="/" aria-label="kapi home"><Logo /></Link>
        <span className="rounded-full border border-line bg-[#e9d5ff] px-2.5 py-0.5 text-[11px] font-semibold">
          Dashboard
        </span>
        <Link to="/app" className="ml-auto text-sm font-medium text-muted hover:text-bright">
          Runs
        </Link>
      </div>
    </header>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="ml-2 text-xs text-dim">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
