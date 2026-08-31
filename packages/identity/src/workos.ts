import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * WorkOS AuthKit, reduced to the two things the orchestrator needs: verifying
 * an access token the browser sent, and borrowing the user's GitHub grant.
 *
 * Kapi never stores a GitHub OAuth token. WorkOS holds the grant and refreshes
 * it; `githubTokenFor` asks for a live one per request. A database that never
 * holds a long-lived third-party credential cannot leak one.
 */
const WORKOS_API = "https://api.workos.com";

export class WorkOSError extends Error {
  constructor(message: string, readonly status = 500, readonly code?: string) {
    super(message);
    this.name = "WorkOSError";
  }
}

export type WorkOSConfig = { clientId: string; apiKey: string };

export function readWorkOSConfig(env: NodeJS.ProcessEnv = process.env): WorkOSConfig | null {
  const clientId = env.WORKOS_CLIENT_ID?.trim();
  const apiKey = env.WORKOS_API_KEY?.trim();
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export type WorkOSUser = {
  id: string;
  email?: string;
  name?: string;
  organizationId?: string;
};

export type WorkOSSession = {
  accessToken: string;
  refreshToken?: string;
  user?: WorkOSUser;
};

/**
 * AuthKit signs with one of two issuers depending on how the session was
 * established, and both are legitimate for the same client - accepting only
 * one produces sporadic 401s that look like clock skew.
 */
const issuersFor = (clientId: string) => [
  WORKOS_API,
  `${WORKOS_API}/`,
  `${WORKOS_API}/user_management/${clientId}`,
];

export class WorkOSAuth {
  #jwks: ReturnType<typeof createRemoteJWKSet>;
  #verified = new Map<string, { user: WorkOSUser; expiresAt: number }>();

  constructor(private config: WorkOSConfig) {
    this.#jwks = createRemoteJWKSet(
      new URL(`${WORKOS_API}/sso/jwks/${encodeURIComponent(config.clientId)}`),
    );
  }

  /**
   * Verifies an access token against WorkOS's published keys.
   *
   * Cached for at most a minute, and never past the token's own expiry, so a
   * revoked session stops working promptly while a burst of dashboard polling
   * does not mean a JWKS round trip each time.
   */
  async verify(accessToken: string): Promise<WorkOSUser> {
    const cached = this.#verified.get(accessToken);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    let payload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.#jwks, {
        issuer: issuersFor(this.config.clientId),
      }));
    } catch {
      throw new WorkOSError("invalid or expired session", 401, "UNAUTHENTICATED");
    }

    if (typeof payload.sub !== "string") {
      throw new WorkOSError("session token has no subject", 401, "UNAUTHENTICATED");
    }
    // A token minted for a different WorkOS client must not authenticate here.
    if (payload.client_id !== undefined && payload.client_id !== this.config.clientId) {
      throw new WorkOSError("session token was issued for another application", 401, "UNAUTHENTICATED");
    }

    const user: WorkOSUser = {
      id: payload.sub,
      organizationId: typeof payload.org_id === "string" ? payload.org_id : undefined,
    };

    this.#verified.set(accessToken, {
      user,
      expiresAt: Math.min(
        typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + 60_000,
        Date.now() + 60_000,
      ),
    });
    // Bounded so a long-lived process cannot accumulate tokens indefinitely.
    if (this.#verified.size > 500) {
      const oldest = this.#verified.keys().next().value;
      if (typeof oldest === "string") this.#verified.delete(oldest);
    }

    return user;
  }

  /** Full profile. Only fetched where the email or name actually matters. */
  async getUser(userId: string): Promise<WorkOSUser> {
    const user = await this.#api<{
      id: string; email?: string; first_name?: string | null; last_name?: string | null;
    }>(`/user_management/users/${encodeURIComponent(userId)}`);

    return {
      id: user.id,
      email: user.email,
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined,
    };
  }

  authorizationUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL(`${WORKOS_API}/user_management/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("provider", "authkit");
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async authenticateWithCode(code: string, redirectUri: string): Promise<WorkOSSession> {
    return this.#session({
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
      client_id: this.config.clientId, client_secret: this.config.apiKey,
    });
  }

  async refreshSession(refreshToken: string): Promise<WorkOSSession> {
    return this.#session({
      grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: this.config.clientId, client_secret: this.config.apiKey,
    });
  }

  async #session(body: Record<string, string>): Promise<WorkOSSession> {
    const result = await this.#api<{
      access_token?: string; refresh_token?: string; user?: {
        id: string; email?: string; first_name?: string; last_name?: string;
      };
    }>("/user_management/authenticate", { method: "POST", body: JSON.stringify(body) });
    if (!result.access_token) throw new WorkOSError("WorkOS did not return an access token", 502);
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      user: result.user ? {
        id: result.user.id, email: result.user.email,
        name: [result.user.first_name, result.user.last_name].filter(Boolean).join(" ") || undefined,
      } : undefined,
    };
  }

  async #api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${WORKOS_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await res.text();
    if (!res.ok) {
      let detail = body.slice(0, 300);
      try { detail = JSON.parse(body).message ?? detail; } catch { /* keep raw */ }
      throw new WorkOSError(`WorkOS ${res.status} on ${path}: ${detail}`, res.status);
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  // ------------------------------------------------------- GitHub connection

  /**
   * The user's live GitHub OAuth token, held and refreshed by WorkOS.
   *
   * This is the *human's* credential. It is used to list repositories and to
   * check that they could have pushed themselves - never to do work, and never
   * inside a sandbox.
   */
  async githubTokenFor(userId: string, organizationId?: string): Promise<string> {
    const res = await this.#api<{
      active: boolean;
      error?: string;
      access_token?: { access_token?: string; missing_scopes?: string[] };
    }>("/pipes/access_token", {
      method: "POST",
      body: JSON.stringify({
        provider: "github",
        user_id: userId,
        ...(organizationId ? { organization_id: organizationId } : {}),
      }),
    }).catch((err) => {
      if (err instanceof WorkOSError && /Data Integration not found|slug=github/i.test(err.message)) {
        throw new WorkOSError(
          "GitHub is not enabled in WorkOS Pipes. Add the GitHub provider there before connecting repositories.",
          503, "GITHUB_NOT_CONFIGURED",
        );
      }
      throw err;
    });

    if (!res.active) {
      throw new WorkOSError(
        res.error === "needs_reauthorization"
          ? "Reconnect GitHub to continue."
          : "Connect GitHub to continue.",
        401, "GITHUB_NOT_CONNECTED",
      );
    }

    const missing = res.access_token?.missing_scopes ?? [];
    if (missing.length > 0) {
      throw new WorkOSError(
        `Reconnect GitHub with the required scopes: ${missing.join(", ")}.`,
        403, "GITHUB_SCOPES_MISSING",
      );
    }

    const token = res.access_token?.access_token;
    if (!token) throw new WorkOSError("Connect GitHub to continue.", 401, "GITHUB_NOT_CONNECTED");
    return token;
  }

  /** Where to send the browser to start (or repair) the GitHub connection. */
  async githubAuthorizationUrl(opts: {
    userId: string;
    organizationId?: string;
    returnTo?: string;
  }): Promise<string> {
    const body = await this.#api<{ url?: string }>("/data-integrations/github/authorize", {
      method: "POST",
      body: JSON.stringify({
        user_id: opts.userId,
        ...(opts.returnTo ? { return_to: opts.returnTo } : {}),
        ...(opts.organizationId ? { organization_id: opts.organizationId } : {}),
      }),
    });
    if (!body.url) throw new WorkOSError("WorkOS did not return a GitHub authorization URL");
    return body.url;
  }

  /** True when the user has a usable GitHub grant, without surfacing the token. */
  async isGithubConnected(userId: string, organizationId?: string): Promise<boolean> {
    try {
      await this.githubTokenFor(userId, organizationId);
      return true;
    } catch {
      return false;
    }
  }
}
