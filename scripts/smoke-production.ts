export {};

const base = (process.env.KAPI_SMOKE_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function check(path: string, expected = 200, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  if (response.status !== expected) {
    throw new Error(`${path}: expected ${expected}, received ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  console.log(`ok ${path} (${response.status})`);
}

await check("/live");
await check("/ready");
if (process.env.KAPI_METRICS_TOKEN) {
  await check("/metrics", 200, { authorization: `Bearer ${process.env.KAPI_METRICS_TOKEN}` });
}
