import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { DbHandle } from "@kapi/db";

const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Resolve the address written by the platform's final trusted proxy.
 *
 * Taking the last valid X-Forwarded-For entry prevents a caller from choosing
 * an arbitrary bucket by prepending a spoofed address. App Platform terminates
 * public traffic before forwarding it to the service; a missing/invalid header shares
 * the conservative "unknown" bucket instead of bypassing the limiter.
 */
export function clientAddress(headers: { get(name: string): string | undefined }): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = forwarded.at(-1) ?? headers.get("x-real-ip")?.trim();
  return candidate && isIP(candidate) ? candidate : "unknown";
}

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
};

/** Shared fixed-window limiter. PostgreSQL makes enforcement replica-safe. */
export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  #nextCleanupAt = 0;
  #cleanup: Promise<void> | null = null;
  #salt: string;

  constructor(
    private handle: DbHandle,
    options: { limit?: number; windowMs?: number; salt?: string } = {},
  ) {
    this.limit = options.limit ?? positiveInt(process.env.KAPI_RATE_LIMIT_PER_MINUTE, 300);
    this.windowMs = options.windowMs ?? 60_000;
    this.#salt = options.salt ?? process.env.KAPI_RATE_LIMIT_SALT ??
      process.env.KAPI_SESSION_SECRET ?? "kapi-development-rate-limit";
  }

  async consume(address: string, now = new Date()): Promise<RateLimitDecision> {
    const bucketMs = Math.floor(+now / this.windowMs) * this.windowMs;
    const bucketStart = new Date(bucketMs);
    const resetAt = new Date(bucketMs + this.windowMs);
    const subject = createHmac("sha256", this.#salt).update(address).digest("hex");
    const rows = await this.handle.raw<{ count: number }>(
      `INSERT INTO api_rate_limits (subject_hash,bucket_start,count)
       VALUES ($1,$2,1)
       ON CONFLICT (subject_hash,bucket_start) DO UPDATE
         SET count=api_rate_limits.count+1
       RETURNING count`,
      [subject, bucketStart.toISOString()],
    );
    const count = Number(rows[0]?.count ?? this.limit + 1);
    this.#scheduleCleanup(now);
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt,
    };
  }

  #scheduleCleanup(now: Date) {
    if (+now < this.#nextCleanupAt || this.#cleanup) return;
    this.#nextCleanupAt = +now + Math.max(this.windowMs * 5, 60_000);
    const cutoff = new Date(+now - this.windowMs * 2).toISOString();
    this.#cleanup = this.handle.raw(`DELETE FROM api_rate_limits WHERE bucket_start < $1`, [cutoff])
      .then(() => {})
      .catch(() => {})
      .finally(() => { this.#cleanup = null; });
  }
}
