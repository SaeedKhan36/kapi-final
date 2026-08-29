import type { DbHandle } from "@kapi/db";
import { resolve as resolveSecret } from "@kapi/identity";
import type { Candidate, ProviderId } from "./types.ts";

/** The env-var name each provider's key is stored under, at any scope. */
export const KEY_NAMES: Record<ProviderId, string[]> = {
  codex: ["OPENAI_API_KEY"],
  // Google's own SDKs read GOOGLE_API_KEY; accept either so a key pasted under
  // the name Google documents does not silently look "unconfigured".
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

export type ResolveScopes = {
  /** The job id. A key attached here beats every wider scope. */
  taskId?: string;
  projectId?: string;
  userId?: string;
};

export type ResolvedKey = {
  provider: ProviderId;
  apiKey: string;
  source: Candidate["keySource"];
};

/**
 * Finds a usable credential for one provider.
 *
 * Order is **task → project → user → platform**, narrowest first. That is the
 * whole mechanism behind per-task BYO keys: attaching a key to one job makes
 * that job, and only that job, run on it.
 *
 * Platform env keys come last on purpose. They are the operator's own quota, so
 * anything a user supplied should be spent before it.
 */
export async function resolveKey(
  handle: DbHandle | null,
  provider: ProviderId,
  scopes: ResolveScopes,
): Promise<ResolvedKey | null> {
  if (handle) {
    for (const name of KEY_NAMES[provider]) {
      const hit = await resolveSecret(handle, name, scopes);
      if (hit) return { provider, apiKey: hit.value, source: hit.scope };
    }
  }
  for (const name of KEY_NAMES[provider]) {
    const fromEnv = process.env[name]?.trim();
    if (fromEnv) return { provider, apiKey: fromEnv, source: "platform" };
  }
  return null;
}

/** Every provider that has a credential, in preference order. */
export async function resolveAllKeys(
  handle: DbHandle | null,
  providers: ProviderId[],
  scopes: ResolveScopes,
): Promise<ResolvedKey[]> {
  const found: ResolvedKey[] = [];
  for (const provider of providers) {
    const key = await resolveKey(handle, provider, scopes);
    if (key) found.push(key);
  }
  return found;
}
