import { Hono } from "hono";
import type { DbHandle } from "@kapi/db";
import type { Principal } from "@kapi/identity";
import {
  authorizationUrl, createPkce, exchangeCode, loadGrant, markGrantRevoked, saveGrant,
  type PkcePair,
} from "@kapi/llm";

type Env = { Variables: { principal: Principal } };

/**
 * Pending PKCE flows, keyed by state.
 *
 * Deliberately in memory: a verifier is single-use and short-lived, and losing
 * pending flows on restart costs a user one click. Persisting it would put a
 * credential-adjacent secret in the database for no benefit.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, { pkce: PkcePair; userId: string; redirectUri: string; at: number }>();

function sweep() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, entry] of pending) if (entry.at < cutoff) pending.delete(state);
}

export function createConnectionRoutes(deps: { handle: DbHandle }) {
  const { handle } = deps;
  const app = new Hono<Env>();

  app.get("/api/connections", async (c) => {
    const rows = await handle.raw<{
      provider: string; status: string; external_id: string | null;
      expires_at: string | null; updated_at: string;
    }>(
      `SELECT provider, status, external_id, expires_at, updated_at
       FROM connections WHERE user_id = $1`,
      [c.get("principal").userId],
    );
    // Never the grant itself - only whether one exists and whether it works.
    return c.json(rows.map((r) => ({
      provider: r.provider,
      status: r.status,
      accountId: r.external_id,
      expiresAt: r.expires_at,
      updatedAt: r.updated_at,
    })));
  });

  /**
   * Starts the Codex sign-in.
   */
  app.post("/api/connections/codex/start", async (c) => {
    sweep();
    const principal = c.get("principal");
    const body = await c.req.json().catch(() => ({}));
    const base = process.env.CONTROL_PLANE_PUBLIC_URL
      ?? `http://localhost:${process.env.CONTROL_PLANE_PORT ?? 8787}`;
    const redirectUri = (body as { redirectUri?: string }).redirectUri
      ?? `${base}/api/connections/codex/callback`;

    const pkce = createPkce();
    pending.set(pkce.state, { pkce, userId: principal.userId, redirectUri, at: Date.now() });
    return c.json({ url: authorizationUrl(pkce, redirectUri), state: pkce.state });
  });

  app.get("/api/connections/codex/callback", async (c) => {
    sweep();
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "missing code or state" }, 400);

    const entry = pending.get(state);
    // An unknown state is either a replay or an expired flow. Both are refused,
    // and the verifier is consumed either way.
    if (!entry) return c.json({ error: "unknown or expired sign-in attempt" }, 400);
    pending.delete(state);

    try {
      const grant = await exchangeCode(code, entry.pkce.verifier, entry.redirectUri);
      await saveGrant(handle, entry.userId, grant);
      return c.json({ connected: true, accountId: grant.accountId ?? null });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          hint: "Codex sign-in failed. Retry the connection or sign in to ChatGPT again.",
        },
        502,
      );
    }
  });

  app.delete("/api/connections/codex", async (c) => {
    const principal = c.get("principal");
    const existing = await loadGrant(handle, principal.userId);
    await markGrantRevoked(handle, principal.userId);
    return c.json({ disconnected: existing !== null });
  });

  return app;
}
