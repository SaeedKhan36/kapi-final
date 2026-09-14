import { spawnSync } from "node:child_process";

export type CommandResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export type CommandProbe = (command: string, args: string[]) => CommandResult;

const runCommand: CommandProbe = (command, args) => spawnSync(command, args, {
  encoding: "utf8",
  timeout: 10_000,
  stdio: ["ignore", "pipe", "pipe"],
});

/** Proves the API can launch the Codex App Server used for device login. */
export function requireCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  probe: CommandProbe = runCommand,
): string {
  const command = env.KAPI_CODEX_BIN?.trim() || "codex";
  const result = probe(command, ["--version"]);
  if (result.error) {
    throw new Error(`Codex executable ${JSON.stringify(command)} is unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(
      `Codex executable ${JSON.stringify(command)} failed its version check` +
      (detail ? `: ${detail.slice(0, 160)}` : ""),
    );
  }
  const version = String(result.stdout ?? "").trim();
  if (!/^codex-cli \d+\.\d+\.\d+(?:\s|$)/.test(version)) {
    throw new Error(`Codex executable ${JSON.stringify(command)} returned an unexpected version string`);
  }
  return version.split(/\s+/).slice(0, 2).join(" ");
}
