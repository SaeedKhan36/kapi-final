import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

/** Snapshot of the real environment, taken before any .env file can clobber it. */
const ORIGINAL = new Map<string, string>(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

/**
 * Loads the nearest .env into process.env, walking up from cwd so it works from
 * any workspace directory. Variables that were already set win, so a real
 * deployment's config is never overwritten by a checked-out file.
 *
 * Uses Node's built-in parser - no dotenv dependency.
 */
export function loadEnv(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);

  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        return null;
      }
      for (const [key, value] of ORIGINAL) process.env[key] = value;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
