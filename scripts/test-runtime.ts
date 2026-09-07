import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(root, "apps/control-plane/dist");
const cleanEnv = (suffix: string): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_URL: "",
  NODE_ENV: "test",
  KAPI_PGLITE_DIR: `memory://runtime-${suffix}`,
  KAPI_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  KAPI_OPERATIONS: "off",
  VM_PROVIDER: "local",
  KAPI_PLANE_ID: "runtime-test",
});

function launch(entry: string, suffix: string, extra: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, [resolve(runtime, entry)], {
    cwd: root,
    env: { ...cleanEnv(suffix), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type RuntimeProcess = ReturnType<typeof launch>;

async function waitForOutput(child: RuntimeProcess, pattern: RegExp) {
  let output = "";
  const append = (chunk: Buffer) => { output += chunk.toString(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const deadline = Date.now() + 20_000;
  while (!pattern.test(output)) {
    if (child.exitCode !== null) throw new Error(`runtime exited ${child.exitCode}: ${output}`);
    if (Date.now() > deadline) throw new Error(`runtime did not become ready: ${output}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return output;
}

async function stop(child: RuntimeProcess) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`runtime stopped with ${child.exitCode}`);
    return;
  }
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  if (code !== 0 && signal !== "SIGTERM") throw new Error(`runtime stopped with ${code ?? signal}`);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a runtime test port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

const migration = launch("migrate.mjs", "migration");
const [migrationCode] = await once(migration, "exit") as [number | null];
if (migrationCode !== 0) throw new Error("compiled migration entrypoint failed");
console.log("  ok   compiled migration entrypoint");

const port = await availablePort();
const api = launch("api.mjs", "api", { PORT: String(port) });
try {
  await waitForOutput(api, /kapi control plane/);
  const [live, ready] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/live`),
    fetch(`http://127.0.0.1:${port}/ready`),
  ]);
  if (!live.ok || !ready.ok) throw new Error(`compiled API unhealthy: ${live.status}/${ready.status}`);
  console.log("  ok   compiled API readiness and shutdown");
} finally {
  await stop(api);
}

const worker = launch("worker.mjs", "worker");
try {
  await waitForOutput(worker, /operations started/);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  if (worker.exitCode !== null) throw new Error(`compiled worker exited early with ${worker.exitCode}`);
  console.log("  ok   compiled worker liveness and shutdown");
} finally {
  await stop(worker);
}
