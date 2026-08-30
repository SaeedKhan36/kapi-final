import type { GitIdentity, RepoRef } from "./types.ts";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
  };
}

export async function gh<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const body = await res.text();
  if (!res.ok) {
    throw new GitHubApiError(`GitHub ${res.status} on ${path}: ${message(body)}`, res.status);
  }
  return (body ? JSON.parse(body) : {}) as T;
}

/** Follows Link rel=next, with a cap so unusually large accounts stay bounded. */
export async function ghPaged<T>(path: string, token: string, maxPages = 5): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = path.startsWith("http") ? path : `${API}${path}`;

  for (let page = 0; next && page < maxPages; page++) {
    const res: Response = await fetch(next, { headers: githubHeaders(token) });
    if (!res.ok) {
      throw new GitHubApiError(
        `GitHub ${res.status} on ${next}: ${message(await res.text())}`,
        res.status,
      );
    }
    items.push(...(await res.json() as T[]));
    next = parseNextLink(res.headers.get("link"));
  }
  return items;
}

function message(body: string): string {
  try { return JSON.parse(body).message ?? body.slice(0, 300); }
  catch { return body.slice(0, 300); }
}

function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const link of header.split(",")) {
    const [url, rel] = link.split(";").map((part) => part.trim());
    if (rel === 'rel="next"') return url?.replace(/^<|>$/g, "");
  }
  return undefined;
}

const enc = encodeURIComponent;

export type Repository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt?: string;
};

type RawRepo = {
  id: number; name: string; full_name: string; private: boolean;
  html_url: string; clone_url: string; default_branch: string;
  updated_at?: string; owner: { login: string };
};

const normalizeRepo = (repo: RawRepo): Repository => ({
  id: repo.id,
  name: repo.name,
  fullName: repo.full_name,
  owner: repo.owner.login,
  private: repo.private,
  htmlUrl: repo.html_url,
  cloneUrl: repo.clone_url,
  defaultBranch: repo.default_branch,
  updatedAt: repo.updated_at,
});

export async function listRepositories(token: string): Promise<Repository[]> {
  const repos = await ghPaged<RawRepo>(
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    token,
  );
  return repos.map(normalizeRepo);
}

export async function getRepository(token: string, ref: RepoRef): Promise<Repository> {
  return normalizeRepo(await gh<RawRepo>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}`, token));
}

export type Branch = { name: string; sha: string; protected: boolean };

export async function listBranches(token: string, ref: RepoRef): Promise<Branch[]> {
  const branches = await ghPaged<{ name: string; protected: boolean; commit: { sha: string } }>(
    `/repos/${enc(ref.owner)}/${enc(ref.repo)}/branches?per_page=100`,
    token,
  );
  return branches.map((branch) => ({
    name: branch.name, sha: branch.commit.sha, protected: branch.protected,
  }));
}

export async function canPush(token: string, ref: RepoRef, username: string): Promise<boolean> {
  try {
    const body = await gh<{
      permission?: string; user?: { permissions?: { push?: boolean } };
    }>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}/collaborators/${enc(username)}/permission`, token);
    return body.user?.permissions?.push === true ||
      ["admin", "maintain", "write"].includes(body.permission ?? "");
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return false;
    throw err;
  }
}

export async function githubUserIdentity(
  token: string,
  fallback: { name?: string | null; email?: string | null } = {},
): Promise<GitIdentity & { username: string }> {
  const user = await gh<{
    login: string; name?: string | null; email?: string | null;
  }>("/user", token);

  let email = user.email ?? fallback.email ?? undefined;
  const emails = await gh<Array<{
    email: string; primary?: boolean; verified?: boolean;
  }>>("/user/emails", token).catch(() => []);

  if (emails.length > 0) {
    email = emails.find((entry) => entry.primary && entry.verified)?.email ??
      emails.find((entry) => entry.verified)?.email ??
      emails.find((entry) => entry.primary)?.email ?? emails[0]?.email ?? email;
  }

  return {
    username: user.login,
    name: user.name ?? fallback.name ?? user.login,
    email: email ?? `${user.login}@users.noreply.github.com`,
  };
}

export type PullRequest = { number: number; html_url: string };

/** Opens a PR, or returns the already-open PR for the same branch. */
export async function openPullRequest(
  token: string,
  ref: RepoRef,
  opts: { head: string; base: string; title: string; body: string },
): Promise<PullRequest> {
  try {
    return await gh<PullRequest>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls`, token, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  } catch (err) {
    const existing = await gh<PullRequest[]>(
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/pulls?head=${enc(`${ref.owner}:${opts.head}`)}&state=open`,
      token,
    ).catch(() => []);
    if (existing.length > 0) return existing[0]!;
    throw err;
  }
}

export async function branchExists(token: string, ref: RepoRef, branch: string): Promise<boolean> {
  try {
    await gh(`/repos/${enc(ref.owner)}/${enc(ref.repo)}/branches/${enc(branch)}`, token);
    return true;
  } catch {
    return false;
  }
}
