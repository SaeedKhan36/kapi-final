import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import { gh, GitHubApiError, githubHeaders } from "./github-api.ts";
import { repoFullName, type RepoRef } from "./types.ts";

const APP_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;

export class GitHubAppError extends Error {
  constructor(message: string, readonly installUrl?: string) {
    super(message);
    this.name = "GitHubAppError";
  }
}

/** Accepts PEM, escaped-newline PEM, or base64-encoded PEM. */
export function decodeAppPrivateKey(value: string): string {
  const normalized = value.trim().replace(/\\n/g, "\n");
  if (normalized.includes("-----BEGIN")) return normalized;
  return Buffer.from(normalized, "base64").toString("utf8").replace(/\\n/g, "\n").trim();
}

export type GitHubAppConfig = { appId: string; privateKey: string };

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !key) return null;
  return { appId, privateKey: decodeAppPrivateKey(key) };
}

/** Creates GitHub's short-lived app-level JWT. */
export async function createAppJwt(config: GitHubAppConfig): Promise<string> {
  let key;
  try {
    key = createPrivateKey(config.privateKey);
  } catch {
    throw new GitHubAppError(
      "GITHUB_APP_PRIVATE_KEY is not a valid PEM private key - use the .pem GitHub gave you",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setIssuer(config.appId)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
}

export type InstallationStatus =
  | { installed: true; installationId: number; installUrl: string }
  | {
      installed: false; installUrl: string; action: "install" | "configure"; reason: string;
    };

/** App-authenticated GitHub client with per-repository token caching. */
export class GitHubApp {
  #slug: Promise<string> | undefined;
  #tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private config: GitHubAppConfig) {}

  async #jwt() { return createAppJwt(this.config); }

  async #app<T>(path: string, init: RequestInit = {}): Promise<T> {
    return gh<T>(path, await this.#jwt(), init);
  }

  async #raw(path: string): Promise<Response> {
    return fetch(`https://api.github.com${path}`, {
      headers: githubHeaders(await this.#jwt()),
    });
  }

  async installUrl(): Promise<string> {
    this.#slug ??= this.#app<{ slug?: string }>("/app")
      .then(({ slug }) => {
        if (!slug) throw new GitHubAppError("GitHub did not return an App slug");
        if (!/^[a-z0-9-]+$/i.test(slug)) {
          throw new GitHubAppError(`GitHub returned an implausible App slug: ${slug}`);
        }
        return slug;
      })
      .catch((err) => { this.#slug = undefined; throw err; });

    return `https://github.com/apps/${encodeURIComponent(await this.#slug)}/installations/new`;
  }

  async installationStatus(ref: RepoRef): Promise<InstallationStatus> {
    assertRef(ref);
    const res = await this.#raw(`/repos/${enc(ref.owner)}/${enc(ref.repo)}/installation`);

    if (res.status === 404) {
      const ownerUrl = await this.#ownerInstallationUrl(ref.owner).catch(() => undefined);
      return ownerUrl
        ? {
            installed: false, installUrl: ownerUrl, action: "configure",
            reason: `Kapi is installed on ${ref.owner} but not on ${repoFullName(ref)}. Add the repository.`,
          }
        : {
            installed: false, installUrl: await this.installUrl(), action: "install",
            reason: `Install the Kapi GitHub App on ${repoFullName(ref)} to let it push branches.`,
          };
    }

    if (!res.ok) {
      throw new GitHubAppError(
        `could not check the Kapi App installation on ${repoFullName(ref)}: GitHub ${res.status}`,
      );
    }

    const installation = await res.json() as {
      id: number; html_url?: string; permissions?: { contents?: string };
    };
    if (installation.permissions?.contents !== "write") {
      return {
        installed: false,
        installUrl: trustedGithubUrl(installation.html_url) ?? await this.installUrl(),
        action: "configure",
        reason: `The Kapi App lacks Contents write access on ${repoFullName(ref)}.`,
      };
    }

    return { installed: true, installationId: installation.id, installUrl: await this.installUrl() };
  }

  async #ownerInstallationUrl(owner: string): Promise<string | undefined> {
    for (const path of [`/orgs/${enc(owner)}/installation`, `/users/${enc(owner)}/installation`]) {
      const res = await this.#raw(path);
      if (res.status === 404) continue;
      if (!res.ok) return undefined;
      const body = await res.json() as { html_url?: string };
      return trustedGithubUrl(body.html_url);
    }
    return undefined;
  }

  /** Mints a contents-write token narrowed to exactly one repository. */
  async tokenFor(ref: RepoRef): Promise<string> {
    assertRef(ref);
    const key = repoFullName(ref).toLowerCase();
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt > Date.now() + REFRESH_SKEW_MS) return cached.token;

    const status = await this.installationStatus(ref);
    if (!status.installed) throw new GitHubAppError(status.reason, status.installUrl);

    const access = await this.#app<{
      token: string; expires_at: string; repositories?: Array<{ full_name?: string }>;
    }>(`/app/installations/${status.installationId}/access_tokens`, {
      method: "POST",
      body: JSON.stringify({
        repositories: [ref.repo],
        permissions: { contents: "write" },
      }),
    }).catch((err) => {
      if (err instanceof GitHubApiError) throw new GitHubAppError(err.message);
      throw err;
    });

    if (!access.token) throw new GitHubAppError("GitHub issued an empty repository token");
    if (access.repositories && !access.repositories.some(
      (repository) => repository.full_name?.toLowerCase() === key,
    )) {
      throw new GitHubAppError(
        `GitHub issued a token for a different repository than ${repoFullName(ref)}`,
      );
    }

    const expiresAt = Date.parse(access.expires_at);
    this.#tokens.set(key, {
      token: access.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + APP_TOKEN_TTL_MS,
    });
    return access.token;
  }

  forget(ref?: RepoRef) {
    if (ref) this.#tokens.delete(repoFullName(ref).toLowerCase());
    else this.#tokens.clear();
  }
}

export function trustedGithubUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function assertRef(ref: RepoRef) {
  if (!ref.owner || !ref.repo || /[\\/]/.test(ref.owner) || /[\\/]/.test(ref.repo)) {
    throw new GitHubAppError(`invalid GitHub repository "${ref.owner}/${ref.repo}"`);
  }
}

const enc = encodeURIComponent;
