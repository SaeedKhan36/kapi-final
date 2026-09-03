import { useCallback, useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { Principal, Setup as SetupState } from "~/lib/types.ts";
import { SecretManager } from "~/components/SecretManager.tsx";
import { Badge, Button, Card, ErrorNote, Spinner } from "~/components/ui.tsx";

export function Setup({ principal }: { principal: Principal }) {
  const oauthResult = new URLSearchParams(location.search).get("codex");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.setup().then(setSetup).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.startCodexConnection(`${location.origin}/setup`);
      location.assign(url);
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

      {oauthResult === "connected" && (
        <p className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          Codex connected successfully.
        </p>
      )}
      {oauthResult === "error" && (
        <ErrorNote>Codex could not be connected. Try again or check the control-plane logs.</ErrorNote>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}

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
