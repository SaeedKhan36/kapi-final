import type { BudgetSnapshot, Usage } from "./types.ts";
import { BudgetExceededError } from "./types.ts";

export type Budget = { maxRequests: number; maxTokens: number };

export function budgetFromEnv(): Budget {
  return {
    maxRequests: Number(process.env.KAPI_MAX_LLM_REQUESTS ?? 2000),
    maxTokens: Number(process.env.KAPI_MAX_LLM_TOKENS ?? 20_000_000),
  };
}

/**
 * A hard ceiling on what one run may spend.
 *
 * The captain can spawn without limit, which is the point of the architecture
 * and also the thing that makes an unbounded bill possible. Concurrency is
 * capped by VM budget; total spend is capped here.
 *
 * Checked BEFORE each request rather than after, because the point is to not
 * make the call that crosses the line.
 */
export class BudgetTracker {
  #used: Usage = { inputTokens: 0, outputTokens: 0, requests: 0 };

  constructor(
    private budget: Budget = budgetFromEnv(),
    private onUsage?: (snapshot: BudgetSnapshot) => void,
  ) {}

  snapshot(): BudgetSnapshot {
    return {
      ...this.#used,
      totalTokens: this.#used.inputTokens + this.#used.outputTokens,
      maxRequests: this.budget.maxRequests,
      maxTokens: this.budget.maxTokens,
    };
  }

  get remainingRequests(): number {
    return Math.max(0, this.budget.maxRequests - this.#used.requests);
  }

  assertAffordable(): void {
    const snap = this.snapshot();
    if (snap.requests >= snap.maxRequests) {
      throw new BudgetExceededError(
        `run hit its request budget (${snap.requests}/${snap.maxRequests})`,
        snap,
      );
    }
    if (snap.totalTokens >= snap.maxTokens) {
      throw new BudgetExceededError(
        `run hit its token budget (${snap.totalTokens}/${snap.maxTokens})`,
        snap,
      );
    }
  }

  record(usage: { inputTokens?: number; outputTokens?: number; requests?: number }): void {
    this.#used.inputTokens += usage.inputTokens ?? 0;
    this.#used.outputTokens += usage.outputTokens ?? 0;
    this.#used.requests += usage.requests ?? 1;
    this.onUsage?.(this.snapshot());
  }
}
