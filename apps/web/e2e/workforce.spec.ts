import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("workforce connection, responsive states, and pause control", async ({ page }, testInfo) => {
  // This optional integration is visible only on deployments that configure it.
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), companyOsOrigin: "https://company.example.com" },
    });
  });
  await signup(
    page,
    `workforce-${Date.now()}@example.com`,
    "workforce-test-password-123",
    "Workforce tester",
  );
  await completeOnboarding(page);
  let connection: null | Record<string, unknown> = null;
  await page.route("**/api/v1/workforce", async (route) => {
    const method = route.request().method();
    if (method === "PUT") {
      const data = route.request().postDataJSON();
      expect(data.key).toBe("test-company-key");
      connection = {
        id: "test-connection",
        endpoint: data.endpoint,
        companyName: "Example company",
        companySlug: "example",
        enabled: true,
        workers: data.workers.map((w: object) => ({ ...w, id: "test-worker" })),
        assignments: [
          {
            id: "test-assignment",
            seq: 12,
            botId: "test-worker",
            runId: "test-run",
            status: "completed",
            synced: true,
          },
        ],
        lastError: null,
        lastSyncedAt: new Date().toISOString(),
      };
    }
    if (method === "PATCH" && connection)
      connection.enabled = route.request().postDataJSON().enabled;
    await route.fulfill({ json: { connection } });
  });
  await page.getByRole("button", { name: "Workforce", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Agent key", { exact: true }).fill("test-company-key");
  await page.getByLabel("OpenRouter model", { exact: true }).fill("test/model");
  for (const [width, scheme] of [
    [1440, "light"],
    [375, "light"],
    [375, "dark"],
    [1440, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, scheme);
    await captureScreenshot(page, testInfo, `workforce-connect-${width}-${scheme}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  }
  await page.getByRole("button", { name: "Connect workforce", exact: true }).click();
  await expect(page.getByText("Example company", { exact: true })).toBeVisible();
  await expect(page.getByText("#12", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("New assignments paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "workforce-connected-paused");
});
