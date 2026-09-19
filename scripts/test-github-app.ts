import { generateKeyPairSync } from "node:crypto";
import { GitHubApp, GITHUB_APP_TOKEN_PERMISSIONS, requireRepositoryAccess } from "@kapi/identity";
import { assert, equal, group, report, test } from "./harness.ts";

group("GitHub App repository tokens");

await test("production repository access fails closed without user authorization", async () => {
  const before = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.WORKOS_CLIENT_ID;
    delete process.env.WORKOS_API_KEY;
    let denied = false;
    try { await requireRepositoryAccess("user_other", { owner: "acme", repo: "private" }); }
    catch { denied = true; }
    assert(denied, "an App installation alone cannot authorize a user");
  } finally {
    for (const key of ["NODE_ENV", "WORKOS_CLIENT_ID", "WORKOS_API_KEY"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

await test("repository access uses the human grant and denies read-only or revoked access", async () => {
  const before = { ...process.env };
  const savedFetch = globalThis.fetch;
  let push = false;
  let active = true;
  try {
    process.env.WORKOS_CLIENT_ID = "client_test";
    process.env.WORKOS_API_KEY = "test-only-key";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "api.workos.com" && url.pathname === "/data-integrations/github/token") {
        equal(JSON.parse(String(init?.body)).user_id, "user_owner", "grant belongs to project owner");
        return Response.json({ active, access_token: { access_token: "human-grant" } });
      }
      equal(url.toString(), "https://api.github.com/repos/acme/private", "exact repository checked");
      equal(new Headers(init?.headers).get("authorization"), "Bearer human-grant", "human identity proves authorization");
      return Response.json({ permissions: { push } });
    };
    const check = () => requireRepositoryAccess("user_owner", { owner: "acme", repo: "private" });
    assert(await check().then(() => false, () => true), "read-only access denied");
    push = true;
    await check();
    active = false;
    assert(await check().then(() => false, () => true), "revoked grant denied even after previous success");
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ["WORKOS_CLIENT_ID", "WORKOS_API_KEY"]) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

const originalFetch = globalThis.fetch;
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let permissions: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
};
let tokenRequest: Record<string, unknown> | undefined;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/repos/acme/widget/installation") {
    return Response.json({
      id: 42,
      html_url: "https://github.com/settings/installations/42",
      permissions,
    });
  }
  if (url.pathname === "/app") return Response.json({ slug: "kapi-test" });
  if (url.pathname === "/app/installations/42/access_tokens" && init?.method === "POST") {
    tokenRequest = JSON.parse(String(init.body));
    return Response.json({
      token: "installation-token",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      repositories: [{ full_name: "acme/widget" }],
    });
  }
  return new Response("not found", { status: 404 });
};

try {
  await test("minted tokens retain branch and pull-request write access", async () => {
    const app = new GitHubApp({ appId: "123", privateKey });
    equal(await app.tokenFor({ owner: "acme", repo: "widget" }), "installation-token", "token returned");
    assert(tokenRequest !== undefined, "installation token request was sent");
    equal(JSON.stringify(tokenRequest?.repositories), JSON.stringify(["widget"]), "token is repository-scoped");
    equal(
      JSON.stringify(tokenRequest?.permissions),
      JSON.stringify(GITHUB_APP_TOKEN_PERMISSIONS),
      "token keeps both required permissions",
    );
  });

  await test("readiness rejects installations that cannot open pull requests", async () => {
    permissions = { contents: "write", pull_requests: "read" };
    const status = await new GitHubApp({ appId: "123", privateKey })
      .installationStatus({ owner: "acme", repo: "widget" });
    assert(!status.installed, "installation is not reported ready");
    if (!status.installed) {
      equal(status.action, "configure", "the user is directed to update the app");
      assert(status.reason.includes("Pull requests write access"), "the missing permission is named");
    }
  });
} finally {
  globalThis.fetch = originalFetch;
}

report();
