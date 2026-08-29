import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A bearer token scoped to exactly one job.
 *
 * An agent runs on a VM the control plane does not trust and cannot reach
 * inbound. It needs a credential to dial out with, and that credential must be
 * worth as little as possible if the VM is compromised: it names one job, it
 * expires, and it grants nothing outside `/agent/*`.
 *
 * Self-verifying (HMAC, no database lookup) because the plane checks it on
 * every heartbeat from every live VM, and a DB round trip per heartbeat is a
 * cost that scales with the fleet.
 */

export class JobTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobTokenError";
  }
}

export type JobTokenClaims = {
  jobId: string;
  runId: string;
  vmId: string;
  /** Seconds since epoch. */
  exp: number;
};

/**
 * Derived from KAPI_SECRET_KEY rather than used directly: a signing key and an
 * encryption key doing double duty means a flaw in one becomes a flaw in both.
 */
function signingKey(): Buffer {
  const raw = process.env.KAPI_SECRET_KEY?.trim();
  if (!raw) {
    throw new JobTokenError(
      "KAPI_SECRET_KEY is not set, so job tokens cannot be signed.\n" +
      "  Generate one with: openssl rand -base64 32",
    );
  }
  const master = Buffer.from(raw, "base64");
  if (master.length !== 32) {
    throw new JobTokenError(`KAPI_SECRET_KEY must decode to 32 bytes, got ${master.length}`);
  }
  return createHmac("sha256", master).update("kapi/job-token/v1").digest();
}

const b64u = (b: Buffer) => b.toString("base64url");

export function mintJobToken(
  claims: Omit<JobTokenClaims, "exp"> & { ttlSeconds?: number },
): string {
  const { ttlSeconds = 6 * 60 * 60, ...rest } = claims;
  const body: JobTokenClaims = { ...rest, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = b64u(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = b64u(createHmac("sha256", signingKey()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyJobToken(token: string | undefined): JobTokenClaims {
  const raw = token?.replace(/^Bearer\s+/i, "").trim();
  if (!raw) throw new JobTokenError("missing job token");

  const [payload, sig] = raw.split(".");
  if (!payload || !sig) throw new JobTokenError("malformed job token");

  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  // Constant-time: a length-varying or short-circuiting compare leaks the
  // signature one byte at a time to anything that can time the endpoint.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new JobTokenError("job token signature does not verify");
  }

  let claims: JobTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new JobTokenError("job token payload is not readable");
  }

  if (!claims.jobId || !claims.runId || !claims.vmId) {
    throw new JobTokenError("job token is missing its scope");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new JobTokenError("job token has expired");
  }
  return claims;
}
