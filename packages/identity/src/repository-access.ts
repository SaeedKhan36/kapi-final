import { gh } from "./github-api.ts";
import { readWorkOSConfig, WorkOSAuth } from "./workos.ts";
import type { RepoRef } from "./types.ts";

/** App installation access is not proof that a particular user may use a repo. */
export async function requireRepositoryAccess(workosId: string, ref: RepoRef): Promise<void> {
  const config = readWorkOSConfig();
  if (!config) {
    if (process.env.NODE_ENV !== "production") return;
    throw new Error("repository user authorization is not configured");
  }
  const token = await new WorkOSAuth(config).githubTokenFor(workosId);
  const repo = await gh<{ permissions?: { push?: boolean } }>(
    `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`, token,
  );
  if (repo.permissions?.push !== true) throw new Error("repository write access is required");
}
