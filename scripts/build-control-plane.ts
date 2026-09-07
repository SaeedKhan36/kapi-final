import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(repoRoot, "apps/control-plane/dist");
const banner = {
  js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
};

await mkdir(outputDir, { recursive: true });

for (const [entryPoint, outfile] of [
  ["apps/control-plane/src/index.ts", "api.mjs"],
  ["apps/control-plane/src/worker.ts", "worker.mjs"],
  ["scripts/migrate.ts", "migrate.mjs"],
] as const) {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [entryPoint],
    outfile: resolve(outputDir, outfile),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner,
  });
}

// PGlite locates these files next to the bundle through import.meta.url. They
// are needed for local/disposable databases; production normally uses Postgres.
const requireFromDb = createRequire(resolve(repoRoot, "packages/db/package.json"));
const pgliteDir = dirname(requireFromDb.resolve("@electric-sql/pglite"));
await Promise.all(
  ["postgres.data", "postgres.wasm"].map((asset) =>
    copyFile(resolve(pgliteDir, asset), resolve(outputDir, asset)),
  ),
);
