import { loadEnv } from "@kapi/env";
loadEnv();

import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { createDb, truncateAll } from "@kapi/db";
import { putSecret } from "@kapi/identity";
import {
  BudgetExceededError, ModelRouter, NoModelAvailableError, classifyFailure,
  createPkce, authorizationUrl, loadGrant, saveGrant, markGrantRevoked, modelsFor,
  resolveKey, type Candidate,
} from "@kapi/llm";
import { assert, equal, group, report, test } from "./harness.ts";
import { seedRun } from "./seed.ts";

if (!process.env.DATABASE_URL) process.env.KAPI_PGLITE_DIR = "memory://llm-test";
if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
}

const handle = await createDb();
console.log(`\n  database: ${handle.target}`);
await truncateAll(handle);

/** A model that answers, or throws whatever the test wants classified. */
function mock(opts: { text?: string; throws?: unknown; tag?: string }): LanguageModel {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: opts.tag ?? "mock",
    doGenerate: async () => {
      if (opts.throws) throw opts.throws;
      return {
        content: [{ type: "text" as const, text: opts.text ?? "ok" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        // The provider-level usage shape, which the AI SDK flattens into the
        // { inputTokens, outputTokens, totalTokens } the router accounts on.
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

const httpError = (status: number, message = "boom") =>
  Object.assign(new Error(message), { statusCode: status });

/* ------------------------------------------------------------------ */

group("failure classification");

await test("each failure kind is recognised from status or message", () => {
  equal(classifyFailure(httpError(429)), "quota", "429");
  equal(classifyFailure(new Error("RESOURCE_EXHAUSTED: quota")), "quota", "quota by message");
  equal(classifyFailure(httpError(404)), "missing", "404");
  equal(classifyFailure(new Error("model not found")), "missing", "missing by message");
  equal(classifyFailure(httpError(401)), "auth", "401");
  equal(classifyFailure(httpError(403)), "auth", "403");
  equal(classifyFailure(httpError(400)), "fatal", "400");
  equal(classifyFailure(httpError(503)), "transient", "503");
  equal(classifyFailure(new Error("fetch failed")), "transient", "network");
});

/* ------------------------------------------------------------------ */

group("key resolution");

await test("a task key beats a project key beats a user key beats the environment", async () => {
  const s = await seedRun(handle);
  process.env.GEMINI_API_KEY = "platform-key";

  equal(
    (await resolveKey(handle, "google", {}))?.source, "platform",
    "with nothing stored, the operator's own key is used last",
  );

  await putSecret(handle, { scope: "user", scopeId: s.userId, name: "GEMINI_API_KEY" }, "user-key");
  let hit = await resolveKey(handle, "google", { userId: s.userId });
  equal(hit?.apiKey, "user-key", "user key wins over platform");

  await putSecret(handle, { scope: "project", scopeId: s.projectId, name: "GEMINI_API_KEY" }, "project-key");
  hit = await resolveKey(handle, "google", { userId: s.userId, projectId: s.projectId });
  equal(hit?.apiKey, "project-key", "project key wins over user");

  await putSecret(handle, { scope: "task", scopeId: "job_abc", name: "GEMINI_API_KEY" }, "task-key");
  hit = await resolveKey(handle, "google", {
    userId: s.userId, projectId: s.projectId, taskId: "job_abc",
  });
  equal(hit?.apiKey, "task-key", "a per-task key overrides everything");
  equal(hit?.source, "task", "and reports where it came from");

  delete process.env.GEMINI_API_KEY;
});

await test("GOOGLE_API_KEY is accepted as well as GEMINI_API_KEY", async () => {
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = "google-named-key";
  const hit = await resolveKey(handle, "google", {});
  equal(hit?.apiKey, "google-named-key", "a key under Google's own name is not invisible");
  delete process.env.GOOGLE_API_KEY;
});

/* ------------------------------------------------------------------ */

group("candidates and rotation");

const withKeys = (env: Record<string, string>, opts = {}) => {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return new ModelRouter({ handle: null, ...opts });
};

const clearKeys = () => {
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENAI_API_KEY"]) {
    delete process.env[k];
  }
};

await test("with no key configured the router says so plainly", async () => {
  clearKeys();
  const router = new ModelRouter({ handle: null });
  equal(await router.isAvailable(), false, "not available");
  let message = "";
  try {
    await router.generate({ prompt: "hi" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.includes("no model provider is configured"), `actionable message: ${message}`);
  assert(message.includes("GEMINI_API_KEY"), "and it names what to set");
});

await test("candidates span every configured provider, best first", async () => {
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g", GROQ_API_KEY: "q", CEREBRAS_API_KEY: "c" });
  const candidates = await router.candidates("coding");
  const providers = [...new Set(candidates.map((c) => c.provider))];
  equal(providers[0], "google", "google leads when codex is not connected");
  assert(providers.includes("groq") && providers.includes("cerebras"), "all keyed providers appear");
  assert(candidates.length >= 4, `several models per provider, got ${candidates.length}`);
});

await test("consecutive calls rotate across a provider's models", async () => {
  // Google's free tier caps requests PER MODEL PER DAY, so pinning one model
  // spends a fraction of the day's capacity per call while siblings idle.
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g" });
  const first = (await router.candidates("coding")).filter((c) => c.provider === "google")[0];
  const second = (await router.candidates("coding")).filter((c) => c.provider === "google")[0];
  assert(
    first!.modelId !== second!.modelId,
    `rotation happened: ${first!.modelId} then ${second!.modelId}`,
  );
});

await test("a per-tier env override reorders that provider's models", () => {
  process.env.KAPI_MODELS_CODING = "gemini-2.5-flash";
  equal(modelsFor("google", "coding")[0], "gemini-2.5-flash", "pinned model leads");
  // An override naming a model this provider does not have must not be sent.
  process.env.KAPI_MODELS_CODING = "llama-3.3-70b-versatile";
  assert(
    !modelsFor("google", "coding").includes("llama-3.3-70b-versatile"),
    "a groq model is not offered to google",
  );
  delete process.env.KAPI_MODELS_CODING;
});

/* ------------------------------------------------------------------ */

group("failover");

await test("a quota error moves to the next model and the call still succeeds", async () => {
  clearKeys();
  const seen: string[] = [];
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    buildModel: (c: Candidate) => {
      seen.push(c.modelId);
      return seen.length === 1 ? mock({ throws: httpError(429, "quota") }) : mock({ text: "second" });
    },
  });

  const res = await router.generate({ prompt: "hi" });
  equal(res.text, "second", "a sibling model answered");
  assert(seen.length === 2, `it tried exactly two models, tried ${seen.length}`);
  assert(router.health().cooling.length === 1, "the exhausted model is cooling down");
});

await test("an exhausted model is not retried on the next call", async () => {
  clearKeys();
  const tried: string[] = [];
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    buildModel: (c: Candidate) => {
      tried.push(c.modelId);
      return c.modelId.includes("3.5") ? mock({ throws: httpError(429) }) : mock({ text: "ok" });
    },
  });

  await router.generate({ prompt: "one" });
  const firstRound = [...tried];
  tried.length = 0;
  await router.generate({ prompt: "two" });

  assert(firstRound.includes("gemini-3.5-flash"), "the first call did try it");
  assert(!tried.includes("gemini-3.5-flash"), "the second call skipped the cooled model");
});

await test("a bad credential skips the whole provider, not one model", async () => {
  clearKeys();
  const providers: string[] = [];
  const router = withKeys({ GEMINI_API_KEY: "bad", GROQ_API_KEY: "good" }, {
    buildModel: (c: Candidate) => {
      providers.push(c.provider);
      return c.provider === "google"
        ? mock({ throws: httpError(401, "invalid api key") })
        : mock({ text: "from groq" });
    },
  });

  const res = await router.generate({ prompt: "hi" });
  equal(res.text, "from groq", "another provider answered");
  equal(
    providers.filter((p) => p === "google").length, 1,
    "one 401 was enough - it did not try every google model with the same dead key",
  );
  assert(router.health().deadProviders.includes("google"), "google is marked dead");
});

await test("a malformed request fails fast instead of burning every candidate", async () => {
  clearKeys();
  let calls = 0;
  const router = withKeys({ GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, {
    buildModel: () => { calls++; return mock({ throws: httpError(400, "invalid schema") }); },
  });

  let caught: unknown;
  try { await router.generate({ prompt: "hi" }); } catch (e) { caught = e; }
  assert(caught instanceof NoModelAvailableError, "surfaced as no-model-available");
  equal(calls, 1, "a request that is wrong repeats identically everywhere, so it stopped at one");
});

await test("when every model fails the error names each attempt", async () => {
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    buildModel: () => mock({ throws: httpError(503, "upstream down") }),
  });

  let message = "";
  try { await router.generate({ prompt: "hi" }); } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes("every model failed"), "says what happened");
  assert(message.includes("[transient]"), "and how each failure was classified");
  assert(message.includes("gemini"), "and which models were tried");
});

/* ------------------------------------------------------------------ */

group("budget");

await test("the request ceiling stops the call that would cross it", async () => {
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    budget: { maxRequests: 2, maxTokens: 1_000_000 },
    buildModel: () => mock({ text: "ok" }),
  });

  await router.generate({ prompt: "one" });
  await router.generate({ prompt: "two" });

  let caught: unknown;
  try { await router.generate({ prompt: "three" }); } catch (e) { caught = e; }
  assert(caught instanceof BudgetExceededError, "budget enforced");
  equal(router.usage().requests, 2, "and the third request was never made");
});

await test("token usage is accumulated from the provider's own accounting", async () => {
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    buildModel: () => mock({ text: "ok" }),
  });
  await router.generate({ prompt: "one" });
  await router.generate({ prompt: "two" });
  const usage = router.usage();
  equal(usage.requests, 2, "requests counted");
  equal(usage.inputTokens, 20, "input tokens summed");
  equal(usage.outputTokens, 10, "output tokens summed");
  equal(usage.totalTokens, 30, "total");
});

await test("a budget error is not failed over to another provider", async () => {
  clearKeys();
  let calls = 0;
  const router = withKeys({ GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, {
    budget: { maxRequests: 0, maxTokens: 1_000_000 },
    buildModel: () => { calls++; return mock({ text: "ok" }); },
  });
  try { await router.generate({ prompt: "hi" }); } catch { /* expected */ }
  equal(calls, 0, "the budget is ours, so spending another key against it makes no sense");
});

/* ------------------------------------------------------------------ */

group("structured output and tools");

await test("generateObject validates against a schema", async () => {
  clearKeys();
  const router = withKeys({ GEMINI_API_KEY: "g" }, {
    buildModel: () => mock({ text: JSON.stringify({ title: "a plan", steps: ["one", "two"] }) }),
  });

  const { object } = await router.generateObject<{ title: string; steps: string[] }>({
    prompt: "plan it",
    schema: z.object({ title: z.string(), steps: z.array(z.string()) }),
  });
  equal(object.title, "a plan", "parsed and validated");
  equal(object.steps.length, 2, "arrays survive");
});

/* ------------------------------------------------------------------ */

group("codex oauth");

await test("the authorization url carries a PKCE challenge, never the verifier", () => {
  const pkce = createPkce();
  const url = new URL(authorizationUrl(pkce, "http://localhost:8787/cb"));
  equal(url.searchParams.get("code_challenge_method"), "S256", "S256");
  equal(url.searchParams.get("code_challenge"), pkce.challenge, "challenge is sent");
  equal(url.searchParams.get("response_type"), "code", "auth-code flow");
  assert(!url.toString().includes(pkce.verifier), "the verifier never leaves the server");
  assert(pkce.challenge !== pkce.verifier, "challenge is a hash, not the secret itself");
});

await test("a grant is stored encrypted and read back", async () => {
  const s = await seedRun(handle);
  await saveGrant(handle, s.userId, {
    accessToken: "codex-access-token", refreshToken: "codex-refresh-token",
    expiresAt: Date.now() + 3_600_000, accountId: "acct_1",
  });

  const rows = await handle.raw<{ ciphertext: string }>(
    `SELECT ciphertext FROM connections WHERE user_id = $1 AND provider = 'codex'`, [s.userId],
  );
  assert(!rows[0]!.ciphertext.includes("codex-access-token"), "not stored in plaintext");

  const grant = await loadGrant(handle, s.userId);
  equal(grant?.accessToken, "codex-access-token", "round-trips");
  equal(grant?.accountId, "acct_1", "account id preserved");
});

await test("a revoked grant stops being offered", async () => {
  const s = await seedRun(handle);
  await saveGrant(handle, s.userId, {
    accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000,
  });
  await markGrantRevoked(handle, s.userId);
  equal(await loadGrant(handle, s.userId), null, "a revoked connection reads as absent");
});

await test("a codex token puts codex first, and its failure falls through silently", async () => {
  clearKeys();
  const order: string[] = [];
  const router = new ModelRouter({
    handle: null,
    codexToken: "codex-bearer",
    buildModel: (c: Candidate) => {
      order.push(c.provider);
      // Codex is undocumented and may vanish; the key providers must cover it.
      return c.provider === "codex"
        ? mock({ throws: httpError(401, "codex grant rejected") })
        : mock({ text: "gemini answered" });
    },
  });
  process.env.GEMINI_API_KEY = "g";

  const res = await router.generate({ prompt: "hi" });
  equal(order[0], "codex", "codex is tried first when connected");
  equal(res.text, "gemini answered", "and its failure is invisible to the caller");
  delete process.env.GEMINI_API_KEY;
});

clearKeys();
await handle.close();
report();
