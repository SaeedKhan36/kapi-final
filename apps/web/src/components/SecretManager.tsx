import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import type { SecretMeta, SecretScope } from "~/lib/types.ts";
import { Button, Card, Empty, ErrorNote, Field, Input, Spinner } from "./ui.tsx";

export function SecretManager(
  { scope, scopeId, title }: { scope: SecretScope; scopeId: string; title: string },
) {
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listSecrets(scope, scopeId).then(setSecrets).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setSecrets([]);
    });
  }, [scope, scopeId]);
  useEffect(load, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.putSecret({ scope, scopeId, name: name.trim().toUpperCase(), value });
      setName("");
      setValue("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secret: SecretMeta) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSecret(scope, scopeId, secret.name);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-3 text-sm font-medium text-muted">{title}</h2>
      <Card className="p-5">
        <p className="mb-4 text-xs text-muted">Values are encrypted and never displayed again.</p>
        <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
          <form className="space-y-3" onSubmit={save}>
            <Field label="Environment name" hint="UPPER_SNAKE_CASE">
              <Input
                required
                pattern="[A-Za-z][A-Za-z0-9_]+"
                value={name}
                placeholder="SERVICE_TOKEN"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Secret value">
              <Input
                required
                type="password"
                autoComplete="new-password"
                value={value}
                placeholder="Stored once, never shown"
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy || !name.trim() || !value}>
              {busy ? <><Spinner /> saving…</> : "Save secret"}
            </Button>
          </form>
          <div className="space-y-2">
            {secrets === null && (
              <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> loading secrets…</p>
            )}
            {secrets?.length === 0 && <Empty>No secrets in this scope.</Empty>}
            {secrets?.map((secret) => (
              <div
                key={secret.id}
                className="flex items-center gap-3 rounded-lg border border-line/50 bg-ink/35 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-bright/90">
                  {secret.name}
                </span>
                <span className="text-[10px] text-muted">encrypted</span>
                <Button
                  type="button"
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void remove(secret)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </section>
  );
}
