/** Accept only canonical GitHub HTTPS or git@github.com SSH clone URLs. */
export function parseGithubRepository(value: string): { owner: string; repo: string } | null {
  const ssh = /^git@github\.com:([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash || value.includes("\\")) return null;
    const path = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!path || [".", ".."].includes(path[2]!)) return null;
    return { owner: path[1]!, repo: path[2]! };
  } catch { return null; }
}

export function githubCredentialRemote(value: string, token: string): string {
  const ref = parseGithubRepository(value);
  if (!ref) throw new Error("refusing GitHub credentials for an untrusted repository URL");
  const url = new URL(`https://github.com/${ref.owner}/${ref.repo}.git`);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}
