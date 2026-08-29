import { loadEnv } from "@kapi/env";
loadEnv();

import { ModelRouter, modelsFor, PROVIDER_ORDER, type ModelTier, type ProviderId } from "@kapi/llm";
import { resolveKey } from "@kapi/llm";

/**
 * Asks every configured provider which of its models actually answer.
 *
 * Worth running against a new key before trusting the catalog: model
 * availability varies per key and project, names in the public docs can 404,
 * and a free tier can be exhausted on one model while its siblings still work.
 * Measuring beats assuming - that is how the old build learned its free tier
 * had no Pro models at all.
 */
const tiers: ModelTier[] = ["reasoning", "coding", "cheap"];
const only = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];

const configured: ProviderId[] = [];
for (const provider of PROVIDER_ORDER) {
  if (only && provider !== only) continue;
  const key = await resolveKey(null, provider, {});
  if (key) configured.push(provider);
}

if (configured.length === 0) {
  console.error(
    "\n  No provider key found.\n" +
    "  Set one of GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENAI_API_KEY.\n",
  );
  process.exit(1);
}

console.log(`\n  configured: ${configured.join(", ")}\n`);

const seen = new Set<string>();
let anyWorked = false;

for (const provider of configured) {
  console.log(`  ${provider}`);
  const models = [...new Set(tiers.flatMap((t) => modelsFor(provider, t)))];

  for (const modelId of models) {
    if (seen.has(`${provider}:${modelId}`)) continue;
    seen.add(`${provider}:${modelId}`);

    // Pinned to exactly one model, so neither rotation nor failover can mask
    // which model actually answered - the whole point of a probe.
    const router = new ModelRouter({
      handle: null,
      budget: { maxRequests: 1, maxTokens: 100_000 },
      pin: { provider, modelId },
    });
    const started = Date.now();
    try {
      const res = await router.generate({
        prompt: "Reply with the single word: ok",
        maxOutputTokens: 64,
      });
      anyWorked = true;
      const usage = router.usage();
      console.log(
        `    ok ${modelId.padEnd(38)} ${String(Date.now() - started).padStart(5)}ms  ` +
        `${usage.totalTokens} tokens  "${res.text.trim().slice(0, 24)}"`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const first = message.split("\n").find((l) => l.includes("[")) ?? message;
      console.log(`    -- ${modelId.padEnd(38)} ${first.trim().slice(0, 90)}`);
    }
  }
  console.log("");
}

if (!anyWorked) {
  console.error("  Nothing answered. Check the key, or the daily quota may be spent.\n");
  process.exit(1);
}
console.log("  Models marked ok are safe to put in the catalog.\n");
