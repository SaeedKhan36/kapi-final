import { loadEnv } from "@kapi/env";
loadEnv();

import {
  validateReleaseConfig, type ReleaseConfigRole,
} from "../apps/control-plane/src/config.ts";
import { requireCodexExecutable } from "./release-prerequisites.ts";

const requested = process.argv.find((arg) => arg.startsWith("--role="))?.slice("--role=".length)
  ?? process.env.KAPI_PREFLIGHT_ROLE
  ?? "all";

if (!["api", "worker", "web", "all"].includes(requested)) {
  console.error(`unknown preflight role "${requested}"; expected api, worker, web, or all`);
  process.exit(2);
}

const roles: ReleaseConfigRole[] = requested === "all"
  ? ["api", "worker", "web"]
  : [requested as ReleaseConfigRole];

let failed = false;
for (const role of roles) {
  try {
    validateReleaseConfig(role);
    const detail = role === "api" ? `; ${requireCodexExecutable()}` : "";
    console.log(`ok production ${role} configuration${detail}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL production ${role} configuration: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed) process.exit(1);
