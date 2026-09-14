import { useCallback, useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { CodexDeviceLogin, Principal, Setup as SetupState } from "~/lib/types.ts";
import { SecretManager } from "~/components/SecretManager.tsx";
import { Badge, Button, Card, ErrorNote, Spinner } from "~/components/ui.tsx";

export function Setup({ principal }: { principal: Principal }) {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<CodexDeviceLogin | null>(null);

  const load = useCallback(() => {
    api.setup().then(setSetup).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!deviceLogin) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await api.codexConnectionStatus(deviceLogin.loginId);
        if (stopped || result.status === "pending") return;
        setBusy(false);
        setDeviceLogin(null);
        if (result.status === "connected") load();
        else setError(result.error ?? "Codex sign-in failed");
      } catch (err) {
        if (!stopped) {
          setBusy(false);
          setDeviceLogin(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    const timer = setInterval(() => void poll(), 2_000);
    void poll();
    return () => { stopped = true; clearInterval(timer); };
  }, [deviceLogin, load]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const login = await api.startCodexConnection();
      setDeviceLogin(login);
      window.open(login.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectCodex();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!setup && !error) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> checking setup…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
        <p className="mt-1.5 text-sm text-muted">
          Connect the tools your fleet needs. Model access is per user; repository access is per project.
        </p>
      </header>

      {error && <ErrorNote>{error}</ErrorNote>}
      {deviceLogin && <CodexDeviceCode login={deviceLogin} />}

      {setup && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Readiness
            label="Account"
            value={setup.auth.mode === "dev" ? "development mode" : "signed in"}
            ok={setup.auth.mode !== "dev"}
            detail={setup.auth.mode === "dev" ? "Configure WorkOS before production." : principal.email ?? principal.name ?? "Authenticated"}
          />
          <Readiness
            label="Codex"
            value={setup.codex.connected ? "connected" : "connection required"}
            ok={setup.codex.connected}
            detail={setup.codex.accountId ?? "Uses your Codex subscription."}
          />
          <Readiness
            label="Vault"
            value={setup.vault.configured ? "encrypted" : "not configured"}
            ok={setup.vault.configured}
            detail="Secrets never return through the API."
          />
          <Readiness
            label="Agent runtime"
            value={setup.vm.provider}
            ok={setup.vm.provider !== "none"}
            detail={setup.github.configured ? "GitHub App configured." : "GitHub App still needs configuration."}
          />
        </div>
      )}

      {setup && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Codex subscription</h2>
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Model access</p>
                  <Badge status={setup.codex.connected ? "success" : "failed"} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {setup.codex.connected
                    ? `Connected${setup.codex.accountId ? ` as ${setup.codex.accountId}` : ""}.`
                    : "Connect before starting an agent run. API keys are not accepted."}
                </p>
              </div>
              {setup.codex.connected ? (
                <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => void connect()}>
                  {busy ? <><Spinner /> connecting…</> : "Connect Codex"}
                </Button>
              )}
            </div>
          </Card>
        </section>
      )}

      <SecretManager scope="user" scopeId={principal.userId} title="User secrets" />
    </div>
  );
}

export function Readiness(
  { label, value, detail, ok }: { label: string; value: string; detail: string; ok: boolean },
) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">{label}</span>
        <span className={`size-1.5 rounded-full ${ok ? "bg-ok" : "bg-warn"}`} aria-label={ok ? "ready" : "needs attention"} />
      </div>
      <p className="mt-2 text-sm font-medium">{value}</p>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </Card>
  );
}

export function CodexDeviceCode({ login }: { login: CodexDeviceLogin }) {
  return (
    <Card className="border-[#7dd3fc] bg-[#f0f9ff] p-4">
      <p className="text-sm font-semibold">Finish signing in to Codex</p>
      <p className="mt-1 text-xs text-muted">
        Open the secure OpenAI page and enter this one-time code. This page will update automatically.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code className="rounded-lg border-[1.5px] border-line bg-white px-4 py-2 text-lg font-bold tracking-[0.16em]">
          {login.userCode}
        </code>
        <a
          className="rounded-full border-[1.5px] border-line bg-[#bae6fd] px-4 py-2 text-sm font-semibold text-bright"
          href={login.verificationUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open OpenAI sign-in
        </a>
        <span className="inline-flex items-center gap-2 text-xs text-muted"><Spinner /> waiting for approval…</span>
      </div>
    </Card>
  );
}
