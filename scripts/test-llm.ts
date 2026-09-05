import { loadEnv } from "@kapi/env";
loadEnv();

import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import {
  BudgetExceededError, ModelRouter, NoModelAvailableError, classifyFailure,
  codexHeaders, createPkce, authorizationUrl, loadGrant, saveGrant, markGrantRevoked, modelsFor,
} from "@kapi/llm";
import { assert, equal, group, report, test } from "./harness.ts";
import { seedRun } from "./seed.ts";
import { createTestDb } from "./test-db.ts";

if (!process.env.KAPI_SECRET_KEY) {
  process.env.KAPI_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
}

const testDb = await createTestDb("llm");
const { handle } = testDb;
console.log(`\n  database: ${handle.target}`);

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

group("Codex candidates");

const withCodex = (opts = {}) => new ModelRouter({ codexToken: "codex-bearer", ...opts });

await test("without a subscription grant the router says so plainly", async () => {
  const router = new ModelRouter();
  equal(await router.isAvailable(), false, "not available");
  let message = "";
  try {
    await router.generate({ prompt: "hi" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(message.includes("Codex is not connected"), `actionable message: ${message}`);
  assert(message.includes("sign in with ChatGPT"), "and it explains how to connect");
});

await test("only subscription-backed Codex candidates are offered", async () => {
  process.env.GEMINI_API_KEY = "must-not-be-used";
  process.env.GROQ_API_KEY = "must-not-be-used";
  process.env.CEREBRAS_API_KEY = "must-not-be-used";
  const router = withCodex();
  const candidates = await router.candidates("coding");
  const providers = [...new Set(candidates.map((c) => c.provider))];
  equal(providers.length, 1, "exactly one provider");
  equal(providers[0], "codex", "Codex is the provider");
  equal(candidates[0]?.keySource, "oauth", "it uses the subscription grant");
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
});

await test("a third-party model override cannot escape the Codex catalog", () => {
  process.env.KAPI_MODELS_CODING = "gemini-3.6-flash";
  assert(
    !modelsFor("codex", "coding").includes("gemini-3.6-flash"),
    "a third-party model is not offered",
  );
  equal(modelsFor("codex", "coding")[0], "gpt-5.6-sol", "Codex flagship remains selected");
  delete process.env.KAPI_MODELS_CODING;
});

/* ------------------------------------------------------------------ */

group("failover");

await test("a rejected Codex grant does not fall through to another provider", async () => {
  const router = withCodex({
    buildModel: () => mock({ throws: httpError(401, "Codex grant rejected") }),
  });

  let caught: unknown;
  try { await router.generate({ prompt: "hi" }); } catch (e) { caught = e; }
  assert(caught instanceof NoModelAvailableError, "the Codex failure is surfaced");
  assert(router.health().deadProviders.includes("codex"), "Codex is marked unavailable");
});

await test("a malformed request fails fast instead of burning every candidate", async () => {
  let calls = 0;
  const router = withCodex({
    buildModel: () => { calls++; return mock({ throws: httpError(400, "invalid schema") }); },
  });

  let caught: unknown;
  try { await router.generate({ prompt: "hi" }); } catch (e) { caught = e; }
  assert(caught instanceof NoModelAvailableError, "surfaced as no-model-available");
  equal(calls, 1, "a request that is wrong repeats identically everywhere, so it stopped at one");
});

await test("when every model fails the error names each attempt", async () => {
  const router = withCodex({
    buildModel: () => mock({ throws: httpError(503, "upstream down") }),
  });

  let message = "";
  try { await router.generate({ prompt: "hi" }); } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message.includes("every model failed"), "says what happened");
  assert(message.includes("[transient]"), "and how each failure was classified");
  assert(message.includes("gpt-5.6-sol"), "and which Codex model was tried");
});

/* ------------------------------------------------------------------ */

group("budget");

await test("the request ceiling stops the call that would cross it", async () => {
  const router = withCodex({
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
  const router = withCodex({
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

await test("a budget error stops before calling Codex", async () => {
  let calls = 0;
  const router = withCodex({
    budget: { maxRequests: 0, maxTokens: 1_000_000 },
    buildModel: () => { calls++; return mock({ text: "ok" }); },
  });
  try { await router.generate({ prompt: "hi" }); } catch { /* expected */ }
  equal(calls, 0, "the budget is ours, so spending another key against it makes no sense");
});

/* ------------------------------------------------------------------ */

group("structured output and tools");

await test("generateObject validates against a schema", async () => {
  const router = withCodex({
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

await test("model requests identify the ChatGPT subscription account", () => {
  const headers = codexHeaders("acct_1");
  equal(headers["chatgpt-account-id"], "acct_1", "account id is forwarded");
  equal(headers.originator, "codex_cli_rs", "request identifies the Codex client");
});

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

await testDb.close();
report();
