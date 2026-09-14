import { Hono } from "hono";
import type { DbHandle } from "@kapi/db";
import type { Principal } from "@kapi/identity";
import { loadGrant, markGrantRevoked } from "@kapi/llm";
import type { CodexConnectionBroker } from "./codex-device-auth.ts";

type Env = { Variables: { principal: Principal } };

export function createConnectionRoutes(deps: {
  handle: DbHandle;
  codexDeviceAuth: CodexConnectionBroker;
}) {
  const { handle, codexDeviceAuth } = deps;
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

  /** Starts Codex App Server's supported device-code ceremony. */
  app.post("/api/connections/codex/start", async (c) => {
    try {
      return c.json(await codexDeviceAuth.start(c.get("principal").userId));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Codex sign-in could not start" }, 502);
    }
  });

  /** Same-user polling endpoint; an opaque login id is not authorization. */
  app.get("/api/connections/codex/pending/:loginId", (c) => {
    const status = codexDeviceAuth.status(c.get("principal").userId, c.req.param("loginId"));
    return status ? c.json(status) : c.json({ error: "Codex sign-in not found" }, 404);
  });

  app.delete("/api/connections/codex", async (c) => {
    const principal = c.get("principal");
    await codexDeviceAuth.cancelUser(principal.userId);
    const existing = await loadGrant(handle, principal.userId);
    await markGrantRevoked(handle, principal.userId);
    return c.json({ disconnected: existing !== null });
  });

  return app;
}
