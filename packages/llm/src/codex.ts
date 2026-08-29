import { createHash, randomBytes } from "node:crypto";
import type { DbHandle } from "@kapi/db";
import { decrypt, encrypt } from "@kapi/identity";
import { newId } from "@kapi/protocol";

/**
 * Signing in with a ChatGPT/Codex subscription instead of pasting an API key.
 *
 * This is an UNDOCUMENTED surface. OpenAI can change or withdraw it without
 * notice, so nothing here is load-bearing: it is one entry in the router's
 * candidate list, and when it fails the key-based providers take over silently.
 * Everything below is written to fail in a way the router can classify rather
 * than in a way that ends a run.
 */

const AUTH_BASE = process.env.KAPI_CODEX_AUTH_URL ?? "https://auth.openai.com";
const API_BASE = process.env.KAPI_CODEX_API_URL ?? "https://chatgpt.com/backend-api/codex";
/** The public client id the Codex CLI uses for its device/PKCE flow. */
const CLIENT_ID = process.env.KAPI_CODEX_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPES = "openid profile email offline_access";

export class CodexAuthError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export type CodexGrant = {
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  accountId?: string;
};

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

const b64u = (b: Buffer) => b.toString("base64url");

export type PkcePair = { verifier: string; challenge: string; state: string };

export function createPkce(): PkcePair {
  const verifier = b64u(randomBytes(64));
  return {
    verifier,
    challenge: b64u(createHash("sha256").update(verifier).digest()),
    state: b64u(randomBytes(16)),
  };
}

export function authorizationUrl(pkce: PkcePair, redirectUri: string): string {
  const url = new URL("/oauth/authorize", AUTH_BASE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<CodexGrant> {
  const res = await fetch(new URL("/oauth/token", AUTH_BASE), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // 5xx is worth retrying; a rejected grant is not.
    throw new CodexAuthError(
      `codex token endpoint ${res.status}: ${text.slice(0, 300)}`,
      res.status >= 500,
    );
  }

  let json: {
    access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new CodexAuthError("codex token endpoint returned a non-JSON body");
  }
  if (!json.access_token) throw new CodexAuthError("codex token response carried no access token");

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    accountId: accountIdFrom(json.id_token),
  };
}

/** Best effort: the account id rides in the id_token's claims when present. */
function accountIdFrom(idToken?: string): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.sub;
  } catch {
    return undefined;
  }
}

export const exchangeCode = (code: string, verifier: string, redirectUri: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

export const refreshGrant = (refreshToken: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: SCOPES,
  });

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Grants are stored in the same AES-256-GCM envelope as every other secret. */
export async function saveGrant(
  handle: DbHandle, userId: string, grant: CodexGrant,
): Promise<void> {
  const env = encrypt(JSON.stringify(grant));
  await handle.raw(
    `INSERT INTO connections (id, user_id, provider, external_id, ciphertext, iv, tag, status, expires_at)
     VALUES ($1, $2, 'codex', $3, $4, $5, $6, 'active', to_timestamp($7))
     ON CONFLICT (user_id, provider) DO UPDATE
       SET external_id = EXCLUDED.external_id, ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv, tag = EXCLUDED.tag, status = 'active',
           expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [
      newId("con"), userId, grant.accountId ?? null,
      env.ciphertext, env.iv, env.tag, Math.floor(grant.expiresAt / 1000),
    ],
  );
}

export async function loadGrant(handle: DbHandle, userId: string): Promise<CodexGrant | null> {
  const rows = await handle.raw<{ ciphertext: string; iv: string; tag: string; status: string }>(
    `SELECT ciphertext, iv, tag, status FROM connections
     WHERE user_id = $1 AND provider = 'codex'`,
    [userId],
  );
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  try {
    return JSON.parse(decrypt(row)) as CodexGrant;
  } catch {
    return null;
  }
}

export async function markGrantRevoked(handle: DbHandle, userId: string): Promise<void> {
  await handle.raw(
    `UPDATE connections SET status = 'revoked', updated_at = now()
     WHERE user_id = $1 AND provider = 'codex'`,
    [userId],
  );
}

/**
 * A live access token, refreshing when it is close to expiry.
 *
 * Refreshed a minute early rather than on expiry: a job that starts a request
 * with fifty seconds left on the token would otherwise fail mid-call for a
 * reason that has nothing to do with the work.
 */
export async function accessTokenFor(
  handle: DbHandle, userId: string,
): Promise<string | null> {
  const grant = await loadGrant(handle, userId);
  if (!grant) return null;

  if (grant.expiresAt - Date.now() > 60_000) return grant.accessToken;
  if (!grant.refreshToken) {
    await markGrantRevoked(handle, userId);
    return null;
  }

  try {
    const refreshed = await refreshGrant(grant.refreshToken);
    // Some responses omit the refresh token, meaning "keep using the old one".
    const merged: CodexGrant = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? grant.refreshToken,
      accountId: refreshed.accountId ?? grant.accountId,
    };
    await saveGrant(handle, userId, merged);
    return merged.accessToken;
  } catch (err) {
    // A refresh that fails for a non-transient reason means the user revoked
    // access. Marking it so stops every later job retrying a dead grant.
    if (!(err instanceof CodexAuthError) || !err.retryable) {
      await markGrantRevoked(handle, userId);
    }
    return null;
  }
}

export const codexApiBase = () => API_BASE;
export const codexConfigured = () => Boolean(CLIENT_ID);
