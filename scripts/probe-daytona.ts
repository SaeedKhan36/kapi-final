import { loadEnv } from "@kapi/env";
loadEnv();

import { DaytonaProvider } from "@kapi/vm";

/**
 * Exercises the Daytona provider against the real service: create, write, exec,
 * spawn a detached process, read its output back, destroy.
 *
 * Creates and deletes exactly one VM. Daytona bills per second, so the destroy
 * is in a finally - a leaked VM quietly burns credit until its idle timer.
 */
const provider = new DaytonaProvider();

if (!(await provider.isAvailable())) {
  console.error("\n  DAYTONA_API_KEY is not set (or the SDK is missing) - nothing to probe.\n");
  process.exit(1);
}

let vmId: string | null = null;
const t0 = Date.now();

try {
  console.log("\n  creating a Daytona VM...");
  const vm = await provider.create({
    name: "kapi-probe",
    idleTtlSeconds: 300,
    env: { KAPI_PROBE: "1" },
  });
  vmId = vm.id;
  console.log(`  created ${vm.id} in ${Date.now() - t0}ms  workdir=${vm.workdir}`);

  const node = await provider.exec(vm.id, "node --version");
  console.log(`  node in the VM: ${node.stdout.trim() || node.stderr.trim()} (exit ${node.exitCode})`);
  if (node.exitCode !== 0) throw new Error("no node in the VM - the agent bundle could not run");

  await provider.writeFile(vm.id, `${vm.workdir}/hello.mjs`,
    `console.log("hello from " + process.env.KAPI_PROBE_NAME);`);
  const readBack = await provider.readFile(vm.id, `${vm.workdir}/hello.mjs`);
  console.log(`  file round-trip: ${readBack.includes("hello from") ? "ok" : "FAILED"}`);

  // The bootstrap path: start a process and return without waiting for it.
  await provider.spawnDetached(vm.id, "node hello.mjs", {
    cwd: vm.workdir,
    env: { KAPI_PROBE_NAME: "kapi" },
  });
  await new Promise((r) => setTimeout(r, 2500));
  const log = await provider.readFile(vm.id, `${vm.workdir}/agent.log`).catch(() => "");
  console.log(`  detached output: ${log.trim() || "(empty)"}`);
  if (!log.includes("hello from kapi")) {
    throw new Error("the detached process did not run - agent bootstrap would fail here");
  }

  console.log(`\n  Daytona provider works. total ${Date.now() - t0}ms\n`);
} catch (err) {
  console.error(`\n  probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  if (vmId) {
    await provider.destroy(vmId).then(
      () => console.log(`  destroyed ${vmId}`),
      (e) => console.error(`  COULD NOT DESTROY ${vmId} - it will bill until its idle timer: ${e}`),
    );
  }
}
