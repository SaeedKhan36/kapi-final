import { expect, test } from "@playwright/test";

test("real browser, API, and database complete the project setup journey", async ({ page }) => {
  const suffix = `${Date.now()}-${test.info().workerIndex}`;
  const projectName = `Live stack ${suffix}`;

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Delegate to your agent team" })).toBeVisible();

  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Repository").fill("https://github.com/SaeedKhan36/kapi-final.git");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(page.getByText("No threads yet — open one to start work.")).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/threads\/thr_/);
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("link", { name: `Back to ${projectName}` }).click();
  await page.getByRole("link", { name: "Schedules" }).click();
  await expect(page).toHaveURL(/\/projects\/prj_.+\/schedules/);

  await page.getByLabel("Name").fill("Pre-deployment check");
  await page.getByLabel("Cron").fill("0 9 * * 1-5");
  await page.getByLabel("Timezone").fill("Asia/Kolkata");
  await page.getByLabel("Goal").fill("Inspect repository health without changing files.");
  await page.getByRole("button", { name: "Create schedule" }).click();

  await expect(page.getByText("Pre-deployment check", { exact: true })).toBeVisible();
  await expect(page.getByText("0 9 * * 1-5 · Asia/Kolkata", { exact: true })).toBeVisible();
});
