export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.KAPI_ALLOWED_ORIGINS?.split(",").map((v) => v.trim()).filter(Boolean);
  if (configured?.length) return configured;
  return env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://localhost:8787"];
}

export function validateProductionConfig(
  role: "api" | "worker" = "api", env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;
  const required = role === "api"
    ? ["DATABASE_URL", "KAPI_SECRET_KEY", "KAPI_SESSION_SECRET", "KAPI_ALLOWED_ORIGINS",
        "CONTROL_PLANE_PUBLIC_URL", "KAPI_WEB_URL", "WORKOS_CLIENT_ID", "WORKOS_API_KEY",
        "WORKOS_REDIRECT_URI", "KAPI_METRICS_TOKEN", "GITHUB_WEBHOOK_SECRET"]
    : ["DATABASE_URL", "KAPI_SECRET_KEY", "CONTROL_PLANE_PUBLIC_URL", "KAPI_PLANE_ID"];
  if (role === "worker" && env.VM_PROVIDER === "daytona") required.push("DAYTONA_API_KEY");
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`missing required production configuration: ${missing.join(", ")}`);

  const secretKey = Buffer.from(env.KAPI_SECRET_KEY!, "base64");
  if (secretKey.length !== 32) throw new Error("KAPI_SECRET_KEY must decode to exactly 32 bytes");
  if (role === "api" && env.KAPI_SESSION_SECRET!.length < 32) {
    throw new Error("KAPI_SESSION_SECRET must be at least 32 characters");
  }

  for (const key of ["CONTROL_PLANE_PUBLIC_URL", ...(role === "api" ? ["KAPI_WEB_URL", "WORKOS_REDIRECT_URI"] : [])]) {
    let url: URL;
    try { url = new URL(env[key]!); }
    catch { throw new Error(`${key} must be a valid absolute URL`); }
    if (url.protocol !== "https:") throw new Error(`${key} must use https in production`);
  }
  if (role === "api") {
    const origins = allowedOrigins(env);
    if (origins.length === 0) throw new Error("at least one KAPI_ALLOWED_ORIGINS value is required");
    for (const origin of origins) {
      let parsed: URL;
      try { parsed = new URL(origin); }
      catch { throw new Error(`KAPI_ALLOWED_ORIGINS contains an invalid URL: ${origin}`); }
      if (parsed.protocol !== "https:" || parsed.origin !== origin.replace(/\/$/, "")) {
        throw new Error(`KAPI_ALLOWED_ORIGINS must contain HTTPS origins without paths: ${origin}`);
      }
    }
    const webOrigin = new URL(env.KAPI_WEB_URL!).origin;
    if (!origins.map((origin) => origin.replace(/\/$/, "")).includes(webOrigin)) {
      throw new Error("KAPI_ALLOWED_ORIGINS must include the KAPI_WEB_URL origin");
    }

    const appId = Boolean(env.GITHUB_APP_ID?.trim());
    const appKey = Boolean(env.GITHUB_APP_PRIVATE_KEY?.trim());
    if (appId !== appKey) {
      throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together");
    }
  } else if (!/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(env.KAPI_PLANE_ID!) || env.KAPI_PLANE_ID === "default") {
    throw new Error("KAPI_PLANE_ID must be a unique non-default deployment identifier");
  }
  const runsOperations = role === "worker" || env.KAPI_OPERATIONS !== "off";
  if (runsOperations && (env.VM_PROVIDER ?? "local") === "local") {
    throw new Error("VM_PROVIDER=local is not allowed for production operations; use docker or daytona");
  }
}

export type ReleaseConfigRole = "api" | "worker" | "web";

/**
 * Stricter than runtime validation: this proves a service is configured for the
 * complete Kapi product, including integrations that the API may legitimately
 * omit while running in a reduced development or maintenance mode.
 */
export function validateReleaseConfig(
  role: ReleaseConfigRole, input: NodeJS.ProcessEnv = process.env,
): void {
  const env: NodeJS.ProcessEnv = { ...input, NODE_ENV: "production" };

  if (role === "api") {
    validateProductionConfig("api", env);
    const required = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"];
    const missing = required.filter((key) => !env[key]?.trim());
    if (missing.length) {
      throw new Error(`missing release integration configuration: ${missing.join(", ")}`);
    }
    const expectedCallback = new URL("/auth/callback", env.CONTROL_PLANE_PUBLIC_URL!).toString();
    if (new URL(env.WORKOS_REDIRECT_URI!).toString() !== expectedCallback) {
      throw new Error(`WORKOS_REDIRECT_URI must be ${expectedCallback}`);
    }
    return;
  }

  if (role === "worker") {
    validateProductionConfig("worker", env);
    return;
  }

  const required = ["VITE_API_URL", "CONTROL_PLANE_PUBLIC_URL"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`missing required web configuration: ${missing.join(", ")}`);
  const api = new URL(env.VITE_API_URL!);
  const plane = new URL(env.CONTROL_PLANE_PUBLIC_URL!);
  if (api.protocol !== "https:") throw new Error("VITE_API_URL must use https in production");
  if (api.origin !== plane.origin || api.pathname.replace(/\/$/, "") !== plane.pathname.replace(/\/$/, "")) {
    throw new Error("VITE_API_URL must point at CONTROL_PLANE_PUBLIC_URL");
  }
}
