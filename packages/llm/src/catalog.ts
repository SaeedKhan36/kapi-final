import type { ModelTier, ProviderId } from "./types.ts";

/**
 * Which models each provider offers per tier, best first.
 *
 * Kept as lists so model selection can expand within Codex without changing
 * the agent protocol or reopening the router to third-party providers.
 */
export const CATALOG: Record<ProviderId, Record<ModelTier, string[]>> = {
  // One current flagship model for every workload. The tier remains part of
  // the agent protocol, but provider selection is intentionally Codex-only.
  codex: {
    reasoning: ["gpt-5.6-sol"],
    coding: ["gpt-5.6-sol"],
    cheap: ["gpt-5.6-sol"],
  },
};

/** Runtime provider policy: subscription-backed Codex only. */
export const PROVIDER_ORDER: ProviderId[] = ["codex"];

/**
 * Per-tier override. Only models explicitly present in the Codex catalog are
 * accepted, so an environment variable cannot re-enable another provider.
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
