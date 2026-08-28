const int = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * How long a claim holds before the reaper may take it back. Agents must
 * heartbeat well inside this window; a value below a few seconds makes normal
 * network jitter look like a dead VM.
 */
export const leaseSeconds = (): number => int(process.env.KAPI_LEASE_SECONDS, 90);

export const defaultMaxAttempts = (): number => int(process.env.KAPI_MAX_ATTEMPTS, 3);
