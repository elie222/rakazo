import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("integration authorization closes its popup without loading the app", async ({ page }) => {
  await page.goto("/");
  const popupOpened = page.waitForEvent("popup");
  await page.evaluate(() => {
    window.open("/integrations/callback?status=success", "rakazo-app-connect", "popup");
  });
  const popup = await popupOpened;
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a callback that cannot close shows only the close-window fallback", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.close = () => {};
  });
  await page.goto("/integrations/callback?status=success");
  await expect(page.getByText("You can close this window.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-rakazo-app-state]")).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integration-callback-fallback");
});
