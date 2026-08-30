/**
 * Which class of model a call wants.
 *
 * A tier, not a model name: callers express the workload shape while the
 * Codex catalog chooses the subscription model.
 */
export type ModelTier = "reasoning" | "coding" | "cheap";

export type ProviderId = "codex";

/** One concrete (provider, model) pair the router may try. */
export type Candidate = {
  provider: ProviderId;
  modelId: string;
  /** Where the credential came from. Reported so a run can be traced to a key. */
  keySource: "oauth";
};

export type Usage = { inputTokens: number; outputTokens: number; requests: number };

export type BudgetSnapshot = Usage & {
  totalTokens: number;
  maxRequests: number;
  maxTokens: number;
};

export class BudgetExceededError extends Error {
  constructor(message: string, readonly snapshot: BudgetSnapshot) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** The provider said no for a reason retrying this model will not fix today. */
export class QuotaExceededError extends Error {
  constructor(readonly provider: ProviderId, readonly modelId: string, message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class NoModelAvailableError extends Error {
  constructor(message: string, readonly attempts: AttemptLog[] = []) {
    super(message);
    this.name = "NoModelAvailableError";
  }
}

export type AttemptLog = {
  provider: ProviderId;
  modelId: string;
  error: string;
  classified: FailureKind;
};

/**
 * Why a call failed, which decides what to do next.
 *
 *   quota    - out of allowance. Cool this model down; try a sibling.
 *   missing  - the model does not exist for this key. Drop it permanently.
 *   auth     - the credential is bad. Skip the whole provider.
 *   transient- server-side blip. Another provider may well work.
 *   fatal    - our request was wrong. Failing over just repeats the mistake.
 */
export type FailureKind = "quota" | "missing" | "auth" | "transient" | "fatal";

/**
 * Classifies a provider error without depending on any provider's error class.
 *
 * Getting this wrong is expensive in both directions: treating a bad request as
 * transient burns the whole candidate list repeating one mistake, and treating
 * a quota error as fatal ends a run that a sibling model could have finished.
 */
export function classifyFailure(err: unknown): FailureKind {
  const status = (err as { statusCode?: number; status?: number })?.statusCode
    ?? (err as { status?: number })?.status;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (status === 429 || /quota|rate.?limit|resource_exhausted|too many requests/.test(message)) {
    return "quota";
  }
  if (status === 404 || /not found|does not exist|unknown model|no such model/.test(message)) {
    return "missing";
  }
  if (status === 401 || status === 403 || /unauthori|invalid.*(api key|token)|permission denied/.test(message)) {
    return "auth";
  }
  if (status === 400 || status === 422 || /invalid.?request|unsupported|schema/.test(message)) {
    return "fatal";
  }
  if (status !== undefined && status >= 500) return "transient";
  if (/timeout|econnreset|enotfound|socket hang up|fetch failed|network/.test(message)) {
    return "transient";
  }
  return "transient";
}
