import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DbHandle } from "@kapi/db";
import { saveGrant, type CodexGrant } from "@kapi/llm";

export type CodexDeviceLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type CodexDeviceLoginStatus = {
  status: "pending" | "connected" | "failed";
  error?: string;
};

export interface CodexConnectionBroker {
  start(userId: string): Promise<CodexDeviceLogin>;
  status(userId: string, loginId: string): CodexDeviceLoginStatus | null;
  cancelUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

type Session = {
  userId: string;
  home: string;
  process: ChildProcessWithoutNullStreams;
  loginId?: string;
  status: CodexDeviceLoginStatus;
  finishing: boolean;
  timeout: ReturnType<typeof setTimeout>;
};

type AppServerMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

const LOGIN_REQUEST_ID = 2;
const MAX_STDERR_CHARS = 4_096;

/**
 * Uses Codex App Server's supported device-code flow. The app-server owns the
 * OAuth ceremony and token refresh format; Kapi imports the resulting grant
 * into its encrypted per-user vault, then immediately removes the plaintext
 * temporary CODEX_HOME.
 */
export class CodexDeviceAuth implements CodexConnectionBroker {
  #sessions = new Set<Session>();
  #byLoginId = new Map<string, Session>();

  constructor(private handle: DbHandle) {}

  async start(userId: string): Promise<CodexDeviceLogin> {
    await this.cancelUser(userId);
    const limit = Number(process.env.KAPI_CODEX_PENDING_MAX ?? 3);
    const active = [...this.#sessions].filter((session) => session.status.status === "pending").length;
    if (active >= limit) throw new Error("too many Codex sign-ins are already pending");

    const home = await mkdtemp(join(tmpdir(), "kapi-codex-auth-"));
    await chmod(home, 0o700);
    const command = process.env.KAPI_CODEX_BIN?.trim() || "codex";
    const child = spawn(command, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(home),
    });

    const session: Session = {
      userId, home, process: child, status: { status: "pending" }, finishing: false,
      timeout: setTimeout(() => void this.#finish(session, false, "Codex sign-in expired"), 15 * 60_000),
    };
    session.timeout.unref?.();
    this.#sessions.add(session);

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on("error", () => { /* process failure is handled by child error/exit */ });

    const lines = createInterface({ input: child.stdout });
    const login = new Promise<CodexDeviceLogin>((resolve, reject) => {
      let settled = false;
      const failStart = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };

      child.once("error", (error) => {
        failStart(error.message.includes("ENOENT")
          ? "Codex App Server is not installed; install the pinned @openai/codex dependency"
          : `Codex App Server could not start: ${error.message}`);
        void this.#finish(session, false, "Codex App Server could not start");
      });
      child.once("exit", (code) => {
        const detail = safeProcessError(stderr) || `exit ${code ?? "unknown"}`;
        failStart(session.status.error ?? `Codex App Server stopped before login began (${detail})`);
        if (!session.finishing) {
          void this.#finish(session, false, "Codex App Server stopped unexpectedly");
        }
      });

      lines.on("line", (line) => {
        let message: AppServerMessage;
        try { message = JSON.parse(line) as AppServerMessage; }
        catch { return; }

        if (message.id === LOGIN_REQUEST_ID) {
          if (message.error) {
            failStart(message.error.message ?? "Codex rejected the device-code request");
            void this.#finish(session, false, "Codex rejected the device-code request");
            return;
          }
          const result = message.result;
          const loginId = typeof result?.loginId === "string" ? result.loginId : undefined;
          const verificationUrl = typeof result?.verificationUrl === "string"
            ? result.verificationUrl : undefined;
          const userCode = typeof result?.userCode === "string" ? result.userCode : undefined;
          if (!loginId || !verificationUrl || !userCode || !trustedVerificationUrl(verificationUrl)) {
            failStart("Codex returned an invalid device-code response");
            void this.#finish(session, false, "Codex returned an invalid device-code response");
            return;
          }
          settled = true;
          session.loginId = loginId;
          this.#byLoginId.set(loginId, session);
          resolve({ loginId, verificationUrl, userCode });
        }

        if (message.method === "account/login/completed") {
          const params = message.params;
          if (params?.loginId !== session.loginId) return;
          if (params?.success === true) void this.#finish(session, true);
          else void this.#finish(
            session, false,
            typeof params?.error === "string" ? params.error : "Codex sign-in was not completed",
          );
        }
      });
    });

    send(child, {
      method: "initialize", id: 1,
      params: { clientInfo: { name: "kapi", title: "Kapi", version: "0.1.0" } },
    });
    send(child, { method: "initialized", params: {} });
    send(child, { method: "account/login/start", id: LOGIN_REQUEST_ID,
      params: { type: "chatgptDeviceCode" } });

    return login;
  }

  status(userId: string, loginId: string): CodexDeviceLoginStatus | null {
    const session = this.#byLoginId.get(loginId);
    return session?.userId === userId ? session.status : null;
  }

  async cancelUser(userId: string): Promise<void> {
    await Promise.all([...this.#sessions]
      .filter((session) => session.userId === userId && session.status.status === "pending")
      .map((session) => this.#finish(session, false, "Codex sign-in cancelled")));
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) =>
      this.#finish(session, false, "Codex sign-in interrupted by shutdown")));
  }

  async #finish(session: Session, succeeded: boolean, error?: string): Promise<void> {
    if (session.finishing) return;
    session.finishing = true;
    clearTimeout(session.timeout);
    try {
      if (succeeded) {
        const grant = await readGrant(session.home);
        await saveGrant(this.handle, session.userId, grant);
        session.status = { status: "connected" };
      } else {
        session.status = { status: "failed", error: error ?? "Codex sign-in failed" };
      }
    } catch (cause) {
      session.status = {
        status: "failed",
        error: cause instanceof Error ? cause.message : "Codex credentials could not be saved",
      };
    } finally {
      session.process.kill("SIGTERM");
      await rm(session.home, { recursive: true, force: true }).catch(() => {});
      // Retain the terminal status briefly so the browser's next poll observes it.
      const forget = setTimeout(() => {
        this.#sessions.delete(session);
        if (session.loginId) this.#byLoginId.delete(session.loginId);
      }, 10 * 60_000);
      forget.unref?.();
    }
  }
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const keep = [
    "PATH", "HOME", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  ];
  return Object.fromEntries([
    ...keep.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
    ["CODEX_HOME", home],
  ]);
}

function trustedVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com";
  } catch { return false; }
}

function safeProcessError(stderr: string): string {
  return stderr.split("\n").map((line) => line.trim())
    .find((line) => line && !/token|code|authorization/i.test(line))?.slice(0, 200) ?? "";
}

export function grantFromCodexAuthCache(value: unknown): CodexGrant {
  const cache = value as {
    auth_mode?: unknown;
    tokens?: { access_token?: unknown; refresh_token?: unknown; account_id?: unknown };
  };
  const accessToken = cache?.tokens?.access_token;
  if (cache?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length < 20) {
    throw new Error("Codex completed sign-in without a usable ChatGPT grant");
  }
  const refreshToken = cache.tokens?.refresh_token;
  const accountId = cache.tokens?.account_id;
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(typeof accountId === "string" && accountId ? { accountId } : {}),
    expiresAt: jwtExpiry(accessToken) ?? Date.now() + 60 * 60_000,
  };
}

async function readGrant(home: string): Promise<CodexGrant> {
  // The completion notification and atomic auth-cache rename can race by a few
  // milliseconds. Retry only the local read; never repeat the login request.
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return grantFromCodexAuthCache(JSON.parse(await readFile(join(home, "auth.json"), "utf8")));
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw last instanceof Error ? last : new Error("Codex auth cache was not created");
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}
