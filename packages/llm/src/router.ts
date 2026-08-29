import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateObject, generateText,
  type LanguageModel, type ModelMessage, type ToolSet,
} from "ai";
import type { DbHandle } from "@kapi/db";
import { BudgetTracker, type Budget } from "./budget.ts";
import { codexApiBase } from "./codex.ts";
import { modelsFor, PROVIDER_ORDER } from "./catalog.ts";
import { resolveAllKeys, type ResolveScopes, type ResolvedKey } from "./keys.ts";
import {
  BudgetExceededError, NoModelAvailableError, classifyFailure,
  type AttemptLog, type Candidate, type ModelTier, type ProviderId,
} from "./types.ts";

export type RouterOptions = {
  handle?: DbHandle | null;
  scopes?: ResolveScopes;
  budget?: Budget;
  /** A live Codex access token, when the user has connected one. */
  codexToken?: string | null;
  onUsage?: (snapshot: ReturnType<BudgetTracker["snapshot"]>) => void;
  onAttempt?: (log: AttemptLog) => void;
  /** Overrides model construction. Tests use it to force failures. */
  buildModel?: (candidate: Candidate, apiKey: string) => LanguageModel;
  /**
   * Restricts the router to exactly one model, disabling rotation and
   * failover. For probing a key model by model, and for pinning a run to a
   * model already known to have quota.
   */
  pin?: { provider: ProviderId; modelId: string };
};

/** Shared call options. Deliberately a small, explicit surface. */
type CommonArgs = {
  tier?: ModelTier;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
};

export type GenerateArgs = CommonArgs & {
  tools?: ToolSet;
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; toolName: string };
  /** Loop control, e.g. `stopWhen: stepCountIs(20)` for an agent turn. */
  stopWhen?: unknown;
  activeTools?: string[];
};

export type ObjectArgs<T> = CommonArgs & {
  schema: unknown;
  schemaName?: string;
  schemaDescription?: string;
  _phantom?: T;
};

/** How long a model sits out after a quota error. */
const QUOTA_COOLDOWN_MS = Number(process.env.KAPI_QUOTA_COOLDOWN_MS ?? 15 * 60 * 1000);

/**
 * Hard ceiling on a single model call.
 *
 * generateText/generateObject have no timeout of their own - a request that
 * never gets a response (a dropped connection the OS never notices, a
 * provider that just sits on it) awaits forever, and #withFailover only
 * fails over on a THROWN error. Without this, one hung call freezes the
 * whole run: no error, no log, nothing for the failover loop to react to.
 */
const MODEL_CALL_TIMEOUT_MS = Number(process.env.KAPI_MODEL_CALL_TIMEOUT_MS ?? 120_000);

/**
 * A fresh timeout signal for one attempt, combined with the caller's if it
 * gave one. Built per-attempt (not once per `generate` call) so a candidate
 * that fails over to a sibling model gets a full new budget rather than
 * whatever was left on a signal that started ticking on the first try.
 */
function callSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/**
 * Picks a model, calls it, and moves on when it fails.
 *
 * Two failure shapes matter and they need different answers:
 *
 *   - A provider is down or the key is bad -> try the next PROVIDER.
 *   - One model is out of quota -> try a SIBLING model on the same provider.
 *
 * The second is what makes the free tiers usable at all. Google's free tier
 * caps requests per model per day (20 on a real key we measured), not per
 * project, so pinning every call to the best model spends a twentieth of the
 * day's capacity per request while its siblings sit idle. Rotating across them
 * multiplies usable quota by the number of models.
 */
export class ModelRouter {
  #budget: BudgetTracker;
  #keys: ResolvedKey[] | null = null;
  /** modelId -> when it may be tried again. */
  #cooldown = new Map<string, number>();
  /** Models this key cannot see at all. Dropped permanently, not cooled down. */
  #missing = new Set<string>();
  /** Providers whose credential was rejected. */
  #deadProviders = new Set<ProviderId>();
  #cursor = new Map<string, number>();

  constructor(private opts: RouterOptions = {}) {
    this.#budget = new BudgetTracker(opts.budget, opts.onUsage);
  }

  get budget() { return this.#budget; }
  usage() { return this.#budget.snapshot(); }

  /** Credentials, resolved once per router. */
  async keys(): Promise<ResolvedKey[]> {
    if (this.#keys) return this.#keys;
    const resolved = await resolveAllKeys(
      this.opts.handle ?? null,
      PROVIDER_ORDER,
      this.opts.scopes ?? {},
    );
    // A Codex grant is a credential like any other, just not one with a key.
    if (this.opts.codexToken && !resolved.some((k) => k.provider === "codex")) {
      resolved.unshift({ provider: "codex", apiKey: this.opts.codexToken, source: "oauth" });
    }
    this.#keys = resolved;
    return resolved;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.keys()).length > 0;
  }

  async describe(): Promise<Array<{ provider: ProviderId; source: string }>> {
    return (await this.keys()).map((k) => ({ provider: k.provider, source: k.source }));
  }

  /**
   * Every (provider, model) worth trying for a tier, best first.
   *
   * Within a provider the model list is rotated so consecutive calls do not all
   * land on the same model; cooled-down and missing models sink to the back or
   * disappear entirely.
   */
  async candidates(tier: ModelTier): Promise<Array<Candidate & { apiKey: string }>> {
    const now = Date.now();
    const out: Array<Candidate & { apiKey: string }> = [];

    const pin = this.opts.pin;
    if (pin) {
      const key = (await this.keys()).find((k) => k.provider === pin.provider);
      return key
        ? [{ provider: pin.provider, modelId: pin.modelId, keySource: key.source, apiKey: key.apiKey }]
        : [];
    }

    for (const key of await this.keys()) {
      if (this.#deadProviders.has(key.provider)) continue;

      const models = modelsFor(key.provider, tier)
        .filter((m) => !this.#missing.has(`${key.provider}:${m}`));
      const healthy = models.filter((m) => (this.#cooldown.get(`${key.provider}:${m}`) ?? 0) <= now);
      const cooling = models.filter((m) => (this.#cooldown.get(`${key.provider}:${m}`) ?? 0) > now);

      // Rotate the healthy set; keep cooling models as a last resort rather
      // than dropping them, so a run can still finish when everything is spent.
      const cursorKey = `${key.provider}:${tier}`;
      let ordered = healthy;
      if (healthy.length > 0) {
        const i = (this.#cursor.get(cursorKey) ?? 0) % healthy.length;
        this.#cursor.set(cursorKey, i + 1);
        ordered = [...healthy.slice(i), ...healthy.slice(0, i)];
      }

      for (const modelId of [...ordered, ...cooling]) {
        out.push({ provider: key.provider, modelId, keySource: key.source, apiKey: key.apiKey });
      }
    }
    return out;
  }

  #model(candidate: Candidate, apiKey: string): LanguageModel {
    if (this.opts.buildModel) return this.opts.buildModel(candidate, apiKey);

    switch (candidate.provider) {
      case "google":
        return createGoogle({ apiKey })(candidate.modelId);
      case "groq":
        return createGroq({ apiKey })(candidate.modelId);
      case "cerebras":
        return createCerebras({ apiKey })(candidate.modelId);
      case "codex":
        // A bearer from the OAuth grant, not an API key. The endpoint speaks
        // the OpenAI wire format, which is the only reason this is expressible
        // through the same interface as the rest.
        return createOpenAICompatible({
          name: "codex",
          baseURL: codexApiBase(),
          apiKey,
          headers: { "originator": "codex_cli_rs" },
        })(candidate.modelId);
    }
  }

  #penalise(candidate: Candidate, kind: ReturnType<typeof classifyFailure>) {
    const id = `${candidate.provider}:${candidate.modelId}`;
    if (kind === "quota") this.#cooldown.set(id, Date.now() + QUOTA_COOLDOWN_MS);
    // A model this key cannot see will never appear; retrying it is pure waste.
    if (kind === "missing") this.#missing.add(id);
    // One bad credential poisons every model behind it, so skip the provider.
    if (kind === "auth") this.#deadProviders.add(candidate.provider);
  }

  /**
   * Runs `call` against candidates until one succeeds.
   *
   * `fatal` failures stop immediately: a malformed request repeats identically
   * on every model, so failing over just spends the whole candidate list making
   * the same mistake.
   */
  async #withFailover<T>(
    tier: ModelTier,
    call: (model: LanguageModel, candidate: Candidate) => Promise<T>,
  ): Promise<{ value: T; candidate: Candidate }> {
    this.#budget.assertAffordable();

    const candidates = await this.candidates(tier);
    if (candidates.length === 0) {
      throw new NoModelAvailableError(
        "no model provider is configured - add a key (GEMINI_API_KEY, GROQ_API_KEY, " +
        "CEREBRAS_API_KEY) or connect a Codex account",
      );
    }

    const attempts: AttemptLog[] = [];
    for (const candidate of candidates) {
      // The candidate list is built before the first attempt, so a provider or
      // model condemned by an earlier failure in THIS loop is still sitting in
      // it. Re-checking here is what turns one 401 into one wasted call rather
      // than one per model behind the same dead key.
      if (this.#deadProviders.has(candidate.provider)) continue;
      if (this.#missing.has(`${candidate.provider}:${candidate.modelId}`)) continue;

      try {
        const value = await call(this.#model(candidate, candidate.apiKey), candidate);
        return { value, candidate };
      } catch (err) {
        // The budget is ours, not the provider's. Failing over would spend
        // another key against a limit we already decided to enforce.
        if (err instanceof BudgetExceededError) throw err;

        const kind = classifyFailure(err);
        const log: AttemptLog = {
          provider: candidate.provider,
          modelId: candidate.modelId,
          error: err instanceof Error ? err.message : String(err),
          classified: kind,
        };
        attempts.push(log);
        this.opts.onAttempt?.(log);
        this.#penalise(candidate, kind);
        if (kind === "fatal") {
          throw new NoModelAvailableError(`request rejected as invalid: ${log.error}`, attempts);
        }
      }
    }

    throw new NoModelAvailableError(
      `every model failed (${attempts.length} attempt(s)):\n` +
        attempts.map((a) => `  - ${a.provider}/${a.modelId} [${a.classified}] ${a.error}`).join("\n"),
      attempts,
    );
  }

  #record(usage: { inputTokens?: number; outputTokens?: number } | undefined) {
    this.#budget.record({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      requests: 1,
    });
  }

  /**
   * Text generation, with native tool calling.
   *
   * Tools go through the AI SDK rather than being parsed out of prose. kapi-old
   * asked the model for a JSON action batch and parsed it by hand because the
   * free tier made every request precious; native tool calls remove that whole
   * class of parsing failure.
   *
   * The options are spelled out rather than derived from the AI SDK's own type,
   * which is generic over the tool set and collapses to its defaults under
   * `Parameters<>`. An explicit surface is also the honest one: it says exactly
   * what this router supports.
   */
  async generate(args: GenerateArgs) {
    const { tier = "coding", ...rest } = args;
    const { value, candidate } = await this.#withFailover(tier, async (model) => {
      const result = await generateText({
        ...rest, model, abortSignal: callSignal(rest.abortSignal),
      } as Parameters<typeof generateText>[0]);
      this.#record(result.usage);
      return result;
    });
    // Object.assign, not a spread: the AI SDK returns a class whose `text`,
    // `toolCalls` and `steps` are getters, and spreading it silently drops
    // every one of them.
    return Object.assign(value, {
      provider: candidate.provider,
      modelId: candidate.modelId,
    });
  }

  /** Structured output validated against a schema. */
  async generateObject<T>(
    args: ObjectArgs<T>,
  ): Promise<{ object: T; provider: ProviderId; modelId: string }> {
    const { tier = "reasoning", ...rest } = args;
    const { value, candidate } = await this.#withFailover(tier, async (model) => {
      const result = await generateObject({
        ...rest, model, abortSignal: callSignal(rest.abortSignal),
      } as Parameters<typeof generateObject>[0]);
      this.#record(result.usage);
      return result;
    });
    return { object: value.object as T, provider: candidate.provider, modelId: candidate.modelId };
  }

  /** Models currently cooling down or dropped. Surfaced in health and events. */
  health() {
    const now = Date.now();
    return {
      cooling: [...this.#cooldown.entries()]
        .filter(([, until]) => until > now)
        .map(([id, until]) => ({ id, secondsLeft: Math.round((until - now) / 1000) })),
      missing: [...this.#missing],
      deadProviders: [...this.#deadProviders],
    };
  }
}
