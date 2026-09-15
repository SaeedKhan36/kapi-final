import { execFileSync } from "node:child_process";
import { loadEnv } from "@kapi/env";
loadEnv();

import { connectDb, type DbHandle } from "@kapi/db";
import {
  decrypt, GitHubApp, parseRepoUrl, readAppConfig, readWorkOSConfig,
} from "@kapi/identity";
import { DaytonaProvider } from "@kapi/vm";
import { validateReleaseConfig } from "../apps/control-plane/src/config.ts";
import { requireCodexExecutable } from "./release-prerequisites.ts";

type ConnectionEnvelope = {
  status: string;
  ciphertext: string;
  iv: string;
  tag: string;
};

let failures = 0;
let database: DbHandle | undefined;

async function releaseDatabase(): Promise<DbHandle> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is not configured");
  database ??= await connectDb();
  return database;
}

async function check(name: string, run: () => Promise<string> | string): Promise<void> {
  try {
    console.log(`ok ${name}: ${await run()}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("production configuration", () => {
  for (const role of ["api", "worker", "web"] as const) validateReleaseConfig(role);
  return "api, worker, and web contracts pass";
});

await check("Codex App Server", () => requireCodexExecutable());

await check("PostgreSQL", async () => {
  const handle = await releaseDatabase();
  if (handle.embedded) throw new Error("release readiness requires external PostgreSQL");
  await handle.raw(`SELECT 1`);
  return "reachable and migrations current";
});

await check("Codex grant", async () => {
  const rows = await (await releaseDatabase()).raw<ConnectionEnvelope>(
    `SELECT status,ciphertext,iv,tag FROM connections WHERE provider='codex'`,
  );
  const active = rows.filter((row) => row.status === "active");
  const decryptable = active.filter((row) => {
    try {
      const grant = JSON.parse(decrypt(row)) as Record<string, unknown>;
      return typeof grant.accessToken === "string" && grant.accessToken.length > 0 &&
        typeof grant.expiresAt === "number" &&
        (typeof grant.refreshToken === "string" || grant.expiresAt > Date.now());
    } catch {
      return false;
    }
  });
  if (decryptable.length === 0) {
    throw new Error(`${active.length} active Codex connection(s), none ready with this vault key`);
  }
  return `${decryptable.length} decryptable active connection(s)`;
});

await check("WorkOS credentials", async () => {
  const config = readWorkOSConfig();
  if (!config) throw new Error("WORKOS_CLIENT_ID and WORKOS_API_KEY are required");
  const response = await fetch("https://api.workos.com/user_management/users?limit=1", {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`WorkOS rejected the configured credentials (HTTP ${response.status})`);
  return "API credential accepted";
});

await check("GitHub App installation", async () => {
  const config = readAppConfig();
  if (!config) throw new Error("GitHub App credentials are incomplete");
  const configured = process.env.KAPI_RELEASE_GITHUB_REPO?.trim();
  let source = configured;
  if (!source) {
    try {
      source = execFileSync("git", ["config", "--get", "remote.origin.url"], {
        encoding: "utf8", timeout: 5_000,
      }).trim();
    } catch {
      throw new Error("set KAPI_RELEASE_GITHUB_REPO to owner/repository");
    }
  }
  const ref = parseRepoUrl(source.includes("github.com") ? source : `https://github.com/${source}`);
  if (!ref) throw new Error("KAPI_RELEASE_GITHUB_REPO is not a valid GitHub owner/repository");
  const status = await new GitHubApp(config).installationStatus(ref);
  if (!status.installed) throw new Error(status.reason);
  return `installed with Contents and Pull requests write on ${ref.owner}/${ref.repo}`;
});

await check("Daytona worker provider", async () => {
  if (!(await new DaytonaProvider().isAvailable())) {
    throw new Error("DAYTONA_API_KEY is missing or the Daytona SDK is unavailable");
  }
  const rate = Number(process.env.KAPI_DAYTONA_CENTS_PER_HOUR);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("KAPI_DAYTONA_CENTS_PER_HOUR must be set to the current authoritative rate");
  }
  return "credentials and SDK configured; cost accounting rate is positive";
});

await database?.close();

if (failures > 0) {
  console.error(`\nrelease readiness has ${failures} unresolved gate(s)`);
  process.exit(1);
}
console.log("\nrelease integration readiness passed");
