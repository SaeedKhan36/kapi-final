import type { VmProvider } from "./types.ts";
import { LocalProvider } from "./providers/local.ts";
import { DockerProvider } from "./providers/docker.ts";
import { DaytonaProvider } from "./providers/daytona.ts";

export * from "./types.ts";
export * from "./git.ts";
export { LocalProvider, DockerProvider, DaytonaProvider };

export type ProviderName = "local" | "docker" | "daytona";

export function createVmProvider(
  name: ProviderName = (process.env.VM_PROVIDER as ProviderName) ?? "local",
): VmProvider {
  switch (name) {
    case "daytona": return new DaytonaProvider();
    case "docker": return new DockerProvider();
    case "local": return new LocalProvider();
    default: throw new Error(`unknown VM_PROVIDER "${name}" (expected local|docker|daytona)`);
  }
}

/** The best provider actually usable here, preferring real isolation. */
export async function detectBestProvider(): Promise<VmProvider> {
  for (const candidate of [new DaytonaProvider(), new DockerProvider(), new LocalProvider()]) {
    if (await candidate.isAvailable()) return candidate;
  }
  return new LocalProvider();
}
