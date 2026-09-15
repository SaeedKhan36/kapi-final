import { generateKeyPairSync } from "node:crypto";
import { GitHubApp, GITHUB_APP_TOKEN_PERMISSIONS } from "@kapi/identity";
import { assert, equal, group, report, test } from "./harness.ts";

group("GitHub App repository tokens");

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
