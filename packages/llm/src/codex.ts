import type { DbHandle } from "@kapi/db";
import { decrypt, encrypt } from "@kapi/identity";
import { newId } from "@kapi/protocol";

/**
 * Signing in with a ChatGPT/Codex subscription instead of pasting an API key.
 *
 * Codex supports ChatGPT sign-in for subscription access. This service keeps a
 * refreshable grant per user and deliberately has no API-key fallback: a
 * rejected or expired grant must be surfaced so the user can reconnect it.
 */

const AUTH_BASE = process.env.KAPI_CODEX_AUTH_URL ?? "https://auth.openai.com";
const API_BASE = process.env.KAPI_CODEX_API_URL ?? "https://chatgpt.com/backend-api/codex";
/** Public Codex client used to refresh grants created by Codex App Server. */
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

export type CodexCredential = Pick<CodexGrant, "accessToken" | "accountId">;

/** Headers required by the subscription-backed Codex endpoint. */
export function codexHeaders(accountId?: string | null): Record<string, string> {
  return {
    originator: "codex_cli_rs",
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
  };
}

async function tokenRequest(body: Record<string, string>): Promise<CodexGrant> {
  const res = await fetch(new URL("/oauth/token", AUTH_BASE), {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  }).catch(() => { throw new CodexAuthError("Codex token endpoint unavailable", true); });
  const text = await res.text();
  if (!res.ok) {
    // 5xx is worth retrying; a rejected grant is not.
    throw new CodexAuthError(
      `codex token endpoint ${res.status}`,
      res.status >= 500 || res.status === 429 || res.status === 408,
    );
  }

  let json: {
    access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new CodexAuthError("codex token endpoint returned a non-JSON body", true);
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
export async function credentialFor(
  handle: DbHandle, userId: string, refresh: typeof refreshGrant = refreshGrant,
): Promise<CodexCredential | null> {
  // Row-lock the connection for the bounded refresh request. A different replica
  // observes the new grant after waiting; revoke/reconnect writes serialize after it.
  return handle.transaction(async tx => {
    const rows=await tx<{ciphertext:string;iv:string;tag:string;status:string}>(
      `SELECT ciphertext,iv,tag,status FROM connections WHERE user_id=$1 AND provider='codex' FOR UPDATE`,[userId]);
    const row=rows[0];if(!row||row.status!=="active")return null;
    let grant:CodexGrant;
    try{grant=JSON.parse(decrypt(row));}catch{return null;}
    if(grant.expiresAt-Date.now()>60_000)return {accessToken:grant.accessToken,accountId:grant.accountId};
    if(!grant.refreshToken){await tx(`UPDATE connections SET status='revoked',updated_at=now() WHERE user_id=$1 AND provider='codex'`,[userId]);return null;}
    let refreshed:CodexGrant;
    try{refreshed=await refresh(grant.refreshToken);}
    catch(error){
      if(error instanceof CodexAuthError&&!error.retryable)await tx(`UPDATE connections SET status='revoked',updated_at=now() WHERE user_id=$1 AND provider='codex'`,[userId]);
      return null;
    }
    const merged:CodexGrant={...refreshed,refreshToken:refreshed.refreshToken??grant.refreshToken,accountId:refreshed.accountId??grant.accountId};
    const envelope=encrypt(JSON.stringify(merged));
    await tx(`UPDATE connections SET ciphertext=$2,iv=$3,tag=$4,expires_at=to_timestamp($5),external_id=$6,updated_at=now()
      WHERE user_id=$1 AND provider='codex'`,[userId,envelope.ciphertext,envelope.iv,envelope.tag,Math.floor(merged.expiresAt/1000),merged.accountId??null]);
    return {accessToken:merged.accessToken,accountId:merged.accountId};
  });
}

/** Backward-compatible token-only view for callers that do not make model requests. */
export async function accessTokenFor(handle: DbHandle, userId: string): Promise<string | null> {
  return (await credentialFor(handle, userId))?.accessToken ?? null;
}

export const codexApiBase = () => API_BASE;
export const codexConfigured = () => Boolean(CLIENT_ID);
