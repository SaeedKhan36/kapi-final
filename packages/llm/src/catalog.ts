import type { ModelTier, ProviderId } from "./types.ts";

/**
 * Which models each provider offers per tier, best first.
 *
 * Ordered lists rather than one pinned name because model availability varies
 * by key: a name in the public docs can 404 for a given project, and a free
 * tier can exhaust one model while its siblings still answer.
 */
export const CATALOG: Record<ProviderId, Record<ModelTier, string[]>> = {
  // OpenAI's Codex surface, reached with a subscription grant. Kept first
  // because it is the user's primary credential when connected.
  codex: {
    reasoning: ["gpt-5.1-codex", "gpt-5.1", "gpt-5"],
    coding: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1"],
    cheap: ["gpt-5.1-codex-mini", "gpt-5-mini"],
  },
  /**
   * Pro models are deliberately absent from the free-tier lists: they carry no
   * free quota at all and 429 immediately, so listing them only adds latency
   * before the Flash model that was always going to serve the request. This was
   * measured against a real key, not assumed.
   */
  google: {
    // gemini-2.5-flash (and -lite) are retired - probed 2026-08-29 against a
    // fresh key and both 404 with "no longer available to new users, use
    // models/gemini-3.6-flash". Confirmed live and answering on that date.
    reasoning: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest"],
    coding: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest"],
    cheap: ["gemini-3.1-flash-lite", "gemini-3.6-flash"],
  },
  groq: {
    reasoning: ["moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile"],
    coding: ["moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile"],
    cheap: ["llama-3.1-8b-instant"],
  },
  cerebras: {
    reasoning: ["qwen-3-235b-a22b-instruct-2507", "llama-3.3-70b"],
    coding: ["qwen-3-coder-480b", "qwen-3-235b-a22b-instruct-2507"],
    cheap: ["llama3.1-8b"],
  },
};

/** Provider order when several are configured. Codex first, then free tiers. */
export const PROVIDER_ORDER: ProviderId[] = ["codex", "google", "groq", "cerebras"];

/**
 * Per-tier override, e.g. KAPI_MODELS_CODING="gemini-2.5-flash,llama-3.3-70b".
 *
 * Lets a run be pinned to models still known to have quota instead of
 * rediscovering exhaustion one wasted request at a time.
 */
export function envModels(tier: ModelTier): string[] | null {
  const raw = process.env[`KAPI_MODELS_${tier.toUpperCase()}`];
  const list = raw?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
  return list.length > 0 ? list : null;
}

export function modelsFor(provider: ProviderId, tier: ModelTier): string[] {
  const override = envModels(tier);
  const all = CATALOG[provider][tier];
  if (!override) return all;
  // An override only reorders models this provider actually has; a name meant
  // for a different provider must not be sent here.
  const picked = override.filter((m) => all.includes(m));
  return picked.length > 0 ? [...picked, ...all.filter((m) => !picked.includes(m))] : all;
}
