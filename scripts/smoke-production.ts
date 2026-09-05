export {};

const base = (process.env.KAPI_SMOKE_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function check(path: string, expected = 200, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(`${path}: expected ${expected}, received ${response.status}: ${text.slice(0, 300)}`);
  }
  console.log(`ok ${path} (${response.status})`);
  return { response, text };
}

await check("/live");
const ready = await check("/ready");
const readiness = JSON.parse(ready.text) as { ok?: boolean; database?: boolean; auth?: string; vault?: boolean };
if (!readiness.ok || !readiness.database) throw new Error(`/ready is not healthy: ${ready.text.slice(0, 300)}`);
if (process.env.KAPI_SMOKE_REQUIRE_PRODUCTION === "true" &&
    (readiness.auth !== "workos" || readiness.vault !== true)) {
  throw new Error(`/ready is healthy but not production-ready: ${ready.text.slice(0, 300)}`);
}
if (process.env.KAPI_METRICS_TOKEN) {
  await check("/metrics", 401);
  await check("/metrics", 200, { authorization: `Bearer ${process.env.KAPI_METRICS_TOKEN}` });
}

const cookie = process.env.KAPI_SMOKE_COOKIE?.trim();
if (cookie) {
  const headers = { cookie };
  await check("/api/me", 200, headers);
  await check("/api/setup", 200, headers);
  const projectId = process.env.KAPI_SMOKE_PROJECT_ID?.trim();
  if (projectId) {
    await check(`/api/projects/${encodeURIComponent(projectId)}`, 200, headers);
    await check(`/api/projects/${encodeURIComponent(projectId)}/integrations`, 200, headers);
  }
}
