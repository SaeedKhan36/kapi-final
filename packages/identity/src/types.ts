/** A GitHub repository, split into the two path components used by its API. */
export type RepoRef = { owner: string; repo: string };

export const repoFullName = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

/** Parses the GitHub repo out of an HTTPS or SSH clone URL. */
export function parseRepoUrl(url: string): RepoRef | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export type GitIdentity = { name: string; email: string };
