import { readFileSync, statSync } from "node:fs";

const dockerfile = readFileSync(new URL("../Dockerfile.web", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../deploy/azure/nginx.conf.template", import.meta.url), "utf8");
const entrypointUrl = new URL("../deploy/azure/web-entrypoint.sh", import.meta.url);
const entrypoint = readFileSync(entrypointUrl, "utf8");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Azure gateway: ${message}`);
}

assert(dockerfile.includes("VITE_API_URL= pnpm build:web"), "browser API URLs must remain same-origin");
assert(dockerfile.includes("USER nginx"), "runtime container must be non-root");
assert(dockerfile.includes("EXPOSE 8080"), "runtime container must expose its unprivileged port");
assert(nginx.includes("proxy_pass ${KAPI_API_ORIGIN}"), "gateway must use the configured private API");
for (const path of ["api", "auth", "webhooks", "ws", "live", "ready", "metrics"]) {
  assert(nginx.includes(path), `gateway route is missing /${path}`);
}
assert(nginx.includes("proxy_set_header Upgrade"), "gateway must preserve WebSocket upgrades");
assert(nginx.includes("try_files $uri $uri/ /index.html"), "SPA fallback is missing");
assert(entrypoint.includes("envsubst '${KAPI_API_ORIGIN}'"), "entrypoint must render only the API origin");
assert((statSync(entrypointUrl).mode & 0o111) !== 0, "entrypoint must be executable in the checkout");

console.log("ok Azure non-root same-origin web gateway contract");
