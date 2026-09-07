import { expect, test, type Page } from "@playwright/test";

const project = {
  id: "prj_e2e", ownerId: "usr_e2e", name: "Payments API",
  repoUrl: "https://github.com/example/payments.git", defaultBranch: "main",
  budgets: {}, createdAt: "2026-09-08T00:00:00.000Z",
};

const setup = {
  auth: { mode: "workos", authenticated: true },
  vault: { configured: true },
  vm: { provider: "daytona" },
  github: { configured: true },
  codex: { connected: true, status: "connected", accountId: "acct_e2e", updatedAt: null },
};

async function mockAuthenticatedApi(page: Page) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/")) {
      return route.continue();
    }

    const key = `${request.method()} ${url.pathname}`;
    const bodies: Record<string, unknown> = {
      "GET /api/me": { userId: "usr_e2e", email: "engineer@example.com", name: "Test Engineer" },
      "GET /api/setup": setup,
      "GET /api/health": {
        ok: true, database: "postgres", auth: "workos", vault: "configured",
        queueDepth: 0, wsClients: 0, vmProvider: "daytona",
      },
      "GET /api/projects": [project],
      "POST /api/projects": project,
      "GET /api/projects/prj_e2e": { project, threads: [], runs: [] },
      "GET /api/projects/prj_e2e/schedules": [],
    };
    const body = bodies[key];
    if (body === undefined) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: key }) });
    }
    return route.fulfill({
      status: key === "POST /api/projects" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("landing page reaches the authentication boundary", async ({ page }) => {
  await page.route("**/api/me", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "authentication required" }),
  }));
  await page.route("**/auth/refresh", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "session expired" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your AI engineering team, working in parallel." })).toBeVisible();
  await page.getByRole("link", { name: "Start a run" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to kapi" })).toBeVisible();
});

test("authenticated project creation navigates without a document reload", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: "Delegate to your agent team" })).toBeVisible();
  await expect(page.getByText("Payments API", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { e2eMarker?: string }).e2eMarker = "preserved"; });
  await page.getByLabel("Project name").fill("Payments API");
  await page.getByLabel("Repository").fill("https://github.com/example/payments.git");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\/projects\/prj_e2e$/);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { e2eMarker?: string }).e2eMarker))
    .toBe("preserved");
  await expect(page.getByRole("heading", { name: "Payments API" })).toBeVisible();
  await expect(page.getByText("No threads yet — open one to start work.")).toBeVisible();
});
