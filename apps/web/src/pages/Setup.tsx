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
    setBusy(true); setError(null);
    try {
      const { url } = await api.startCodexConnection(`${location.origin}/setup`);
      location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true); setError(null);
    try { await api.disconnectCodex(); load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  if (!setup && !error) return <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> checking setup…</p>;

  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Workspace readiness</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Connect the tools your fleet needs</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Kapi keeps model access per user and repository access per project. Credentials stay in the control plane.
        </p>
      </header>
      {oauthResult === "connected" && <p className="rounded-lg border border-ok/25 bg-ok/10 px-4 py-3 text-sm text-ok">Codex connected successfully.</p>}
      {oauthResult === "error" && <ErrorNote>Codex could not be connected. Try again or check the control-plane logs.</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {setup && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Readiness label="Account" value={setup.auth.mode === "dev" ? "development mode" : "signed in"}
            ok={setup.auth.mode !== "dev"} detail={setup.auth.mode === "dev" ? "Configure WorkOS before production." : principal.email ?? principal.name ?? "Authenticated"} />
          <Readiness label="Codex" value={setup.codex.connected ? "connected" : "connection required"}
            ok={setup.codex.connected} detail={setup.codex.accountId ?? "Uses your Codex subscription."} />
          <Readiness label="Vault" value={setup.vault.configured ? "encrypted" : "not configured"}
            ok={setup.vault.configured} detail="Secrets never return through the API." />
          <Readiness label="Agent runtime" value={setup.vm.provider} ok={setup.vm.provider !== "none"}
            detail={setup.github.configured ? "GitHub App configured." : "GitHub App still needs configuration."} />
        </div>
      )}

      {setup && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-4 border-b border-line/50 px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">Codex subscription</h2>
              <p className="mt-1 text-xs text-muted">Model calls use this connection; API keys are not accepted.</p>
            </div>
            <Badge status={setup.codex.connected ? "success" : "failed"} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 p-5">
            <p className="text-sm text-muted">
              {setup.codex.connected ? `Connected${setup.codex.accountId ? ` as ${setup.codex.accountId}` : ""}.` : "Connect before starting an agent run."}
            </p>
            {setup.codex.connected
              ? <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
              : <Button disabled={busy} onClick={() => void connect()}>{busy ? <><Spinner /> connecting…</> : "Connect Codex"}</Button>}
          </div>
        </Card>
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
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted">{label}</span>
        <span className={`size-2 rounded-full ${ok ? "bg-ok" : "bg-warn"}`} aria-label={ok ? "ready" : "needs attention"} />
      </div>
      <p className="mt-3 text-sm font-medium">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
    </Card>
  );
}
