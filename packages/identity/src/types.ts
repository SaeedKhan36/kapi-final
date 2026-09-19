/** A GitHub repository, split into the two path components used by its API. */
export type RepoRef = { owner: string; repo: string };

export const repoFullName = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

/** Parses the GitHub repo out of an HTTPS or SSH clone URL. */
export { parseGithubRepository as parseRepoUrl } from "@kapi/protocol";

export type GitIdentity = { name: string; email: string };
