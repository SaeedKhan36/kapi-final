import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DbHandle } from "@kapi/db";
import { newId } from "@kapi/protocol";

/**
 * Secrets, encrypted at rest and never returned over the API.
 *
 * The only way a value leaves this module is `resolve`, which the control plane
 * calls to inject credentials into a VM. Every listing path returns names and
 * scopes only - there is no route, and no function here, that hands a
 * plaintext secret back to a browser.
 */

export const SECRET_SCOPES = ["user", "project", "task"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/**
 * Narrowest scope wins. This is what makes per-task BYO keys work: a key
 * attached to one task overrides the project's, which overrides the user's.
 */
const PRECEDENCE: readonly SecretScope[] = ["task", "project", "user"];

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

type Envelope = { ciphertext: string; iv: string; tag: string };

function key(): Buffer {
  const raw = process.env.KAPI_SECRET_KEY?.trim();
  if (!raw) {
    throw new VaultError(
      "KAPI_SECRET_KEY is not set, so secrets cannot be stored.\n" +
      "  Generate one with: openssl rand -base64 32",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new VaultError(
      `KAPI_SECRET_KEY must decode to 32 bytes for AES-256, got ${buf.length}.\n` +
      "  Generate one with: openssl rand -base64 32",
    );
  }
  return buf;
}

/** True when a key is configured and usable. Surfaced by /api/health. */
export function vaultConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(env: Envelope): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  // GCM authenticates on final(): a tampered ciphertext throws rather than
  // returning plausible-looking garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export type SecretRef = { scope: SecretScope; scopeId: string; name: string };
export type SecretMeta = SecretRef & { id: string; createdAt: Date; updatedAt: Date };

export async function putSecret(
  handle: DbHandle, ref: SecretRef, value: string,
): Promise<SecretMeta> {
  const env = encrypt(value);
  const rows = await handle.raw<{
    id: string; scope: string; scope_id: string; name: string;
    created_at: string | Date; updated_at: string | Date;
  }>(
    `INSERT INTO secrets (id, scope, scope_id, name, ciphertext, iv, tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope, scope_id, name) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
           tag = EXCLUDED.tag, updated_at = now()
     RETURNING id, scope, scope_id, name, created_at, updated_at`,
    [newId("sec"), ref.scope, ref.scopeId, ref.name, env.ciphertext, env.iv, env.tag],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    scope: row.scope as SecretScope,
    scopeId: row.scope_id,
    name: row.name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Metadata only. There is deliberately no `getSecret` that returns a value. */
export async function listSecrets(
  handle: DbHandle, scope: SecretScope, scopeId: string,
): Promise<SecretMeta[]> {
  const rows = await handle.raw<{
    id: string; scope: string; scope_id: string; name: string;
    created_at: string | Date; updated_at: string | Date;
  }>(
    `SELECT id, scope, scope_id, name, created_at, updated_at
     FROM secrets WHERE scope = $1 AND scope_id = $2 ORDER BY name`,
    [scope, scopeId],
  );
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope as SecretScope,
    scopeId: r.scope_id,
    name: r.name,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }));
}

export async function deleteSecret(
  handle: DbHandle, scope: SecretScope, scopeId: string, name: string,
): Promise<boolean> {
  const rows = await handle.raw<{ id: string }>(
    `DELETE FROM secrets WHERE scope = $1 AND scope_id = $2 AND name = $3 RETURNING id`,
    [scope, scopeId, name],
  );
  return rows.length > 0;
}

export type ResolveScopes = { taskId?: string; projectId?: string; userId?: string };

/**
 * Resolves one secret by name across a scope chain, narrowest first.
 *
 * The single place plaintext leaves the vault. Callers pass it straight into a
 * VM's environment; it must never be logged, echoed in an event, or returned
 * from an HTTP route.
 */
export async function resolve(
  handle: DbHandle, name: string, scopes: ResolveScopes,
): Promise<{ value: string; scope: SecretScope } | null> {
  const idFor = (scope: SecretScope) =>
    scope === "task" ? scopes.taskId : scope === "project" ? scopes.projectId : scopes.userId;

  for (const scope of PRECEDENCE) {
    const scopeId = idFor(scope);
    if (!scopeId) continue;

    const rows = await handle.raw<{ ciphertext: string; iv: string; tag: string }>(
      `SELECT ciphertext, iv, tag FROM secrets
       WHERE scope = $1 AND scope_id = $2 AND name = $3`,
      [scope, scopeId, name],
    );
    const row = rows[0];
    if (row) return { value: decrypt(row), scope };
  }
  return null;
}

/** Resolves several names at once, for building a VM's environment. */
export async function resolveAll(
  handle: DbHandle, names: string[], scopes: ResolveScopes,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const hit = await resolve(handle, name, scopes);
    if (hit) out[name] = hit.value;
  }
  return out;
}
