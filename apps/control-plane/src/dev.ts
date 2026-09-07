/**
 * Safe defaults for the one-command local development stack.
 *
 * Set these before importing the API entrypoint so a production-oriented .env
 * cannot make `pnpm dev` connect to a hosted database or create paid VMs by
 * accident. Values explicitly exported by the invoking shell still win.
 */
export {};

const localDefaults: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "",
  KAPI_OPERATIONS: "on",
  KAPI_PLANE_ID: "local-development",
  KAPI_PROVISIONER: "on",
  KAPI_SCHEDULER: "on",
  KAPI_RECONCILER: "on",
  KAPI_RECONCILE_DELETE: "false",
  VM_PROVIDER: "local",
  CONTROL_PLANE_PUBLIC_URL: "http://localhost:8787",
  KAPI_WEB_URL: "http://localhost:3000",
  KAPI_ALLOWED_ORIGINS: "http://localhost:3000,http://localhost:8787",
  WORKOS_CLIENT_ID: "",
  WORKOS_API_KEY: "",
  WORKOS_REDIRECT_URI: "http://localhost:8787/auth/callback",
};

for (const [key, value] of Object.entries(localDefaults)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

await import("./index.ts");
