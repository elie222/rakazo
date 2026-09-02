import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function failSessionLookups(page: Page) {
  await page.route("**/api/auth/get-session*", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "unavailable" }),
    });
  });
}

/** Better Auth rate-limits focus refetch to once per 5s; wait then poke visibility. */
async function triggerSessionRefetch(page: Page) {
  await page.waitForTimeout(5_500);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("shows the reconnect banner after a live session lookup fails", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `reconnect-banner-${stamp}@rakazo.test`, "password12", "Reconnect Banner");
  await completeOnboarding(page);

  await failSessionLookups(page);
  await triggerSessionRefetch(page);

  const banner = page.locator('[data-rakazo-reconnect="banner"]');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner.getByRole("button", { name: "Retry now" })).toBeVisible();
  await expect(page.getByText("Can't reach the server.")).toBeVisible();
  await captureScreenshot(page, testInfo, "session-reconnect-banner");
});

test("shows the blocking reconnect screen on a cold unreachable load", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `reconnect-blocking-${stamp}@rakazo.test`, "password12", "Reconnect Blocking");
  await completeOnboarding(page);

  await failSessionLookups(page);
  await page.reload();

  const blocking = page.locator('[data-rakazo-reconnect="blocking"]');
  await expect(blocking).toBeVisible({ timeout: 15_000 });
  await expect(blocking.getByRole("button", { name: "Retry now" })).toBeVisible();
  await expect(page.getByText("Can't reach the server.")).toBeVisible();
  await captureScreenshot(page, testInfo, "session-reconnect-blocking");
});
