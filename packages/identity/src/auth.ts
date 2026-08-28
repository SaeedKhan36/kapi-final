import type { DbHandle } from "@kapi/db";
import { newId } from "@kapi/protocol";
import { readWorkOSConfig, WorkOSAuth, WorkOSError, type WorkOSUser } from "./workos.ts";

export type Principal = {
  userId: string;
  workosId: string;
  email?: string;
  name?: string;
  organizationId?: string;
  /** "workos" for a verified session, "dev" for the unauthenticated local user. */
  via: "workos" | "dev";
};

/**
 * The fixed identity used when WorkOS is not configured.
 *
 * Local development must not require a WorkOS tenant, but an unauthenticated
 * mode that is indistinguishable from a real one is how a dev shortcut ends up
 * deployed. So it is a named, obvious identity, and /api/health reports
 * `auth: "dev"` loudly.
 */
const DEV_WORKOS_ID = "dev-local-user";

export class Authenticator {
  #workos: WorkOSAuth | null;

  constructor(private handle: DbHandle) {
    const config = readWorkOSConfig();
    this.#workos = config ? new WorkOSAuth(config) : null;
  }

  get mode(): "workos" | "dev" {
    return this.#workos ? "workos" : "dev";
  }

  /**
   * Resolves the caller. Throws WorkOSError(401) when a session is required
   * and absent or invalid.
   */
  async authenticate(authorization?: string): Promise<Principal> {
    if (!this.#workos) return this.#devPrincipal();

    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new WorkOSError("sign in to continue", 401, "UNAUTHENTICATED");

    const verified = await this.#workos.verify(token);
    // The token carries only a subject; the profile is a separate call, made
    // once at first sight rather than on every request.
    const existing = await this.#findByWorkosId(verified.id);
    if (existing) {
      return { ...existing, organizationId: verified.organizationId, via: "workos" };
    }

    const profile = await this.#workos.getUser(verified.id).catch(() => verified);
    const created = await this.#upsert(profile);
    return { ...created, organizationId: verified.organizationId, via: "workos" };
  }

  async #devPrincipal(): Promise<Principal> {
    const existing = await this.#findByWorkosId(DEV_WORKOS_ID);
    if (existing) return { ...existing, via: "dev" };
    const created = await this.#upsert({
      id: DEV_WORKOS_ID, email: "dev@kapi.local", name: "Local Developer",
    });
    return { ...created, via: "dev" };
  }

  async #findByWorkosId(workosId: string) {
    const rows = await this.handle.raw<{
      id: string; workos_id: string; email: string | null; name: string | null;
    }>(`SELECT id, workos_id, email, name FROM users WHERE workos_id = $1`, [workosId]);
    const row = rows[0];
    return row
      ? {
          userId: row.id,
          workosId: row.workos_id,
          email: row.email ?? undefined,
          name: row.name ?? undefined,
        }
      : null;
  }

  async #upsert(user: WorkOSUser) {
    const rows = await this.handle.raw<{
      id: string; workos_id: string; email: string | null; name: string | null;
    }>(
      `INSERT INTO users (id, workos_id, email, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workos_id) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, users.email),
             name  = COALESCE(EXCLUDED.name,  users.name)
       RETURNING id, workos_id, email, name`,
      [newId("usr"), user.id, user.email ?? null, user.name ?? null],
    );
    const row = rows[0]!;
    return {
      userId: row.id,
      workosId: row.workos_id,
      email: row.email ?? undefined,
      name: row.name ?? undefined,
    };
  }
}
