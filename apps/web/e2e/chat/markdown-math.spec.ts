import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("a bot reply typesets inline and display equations", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 1020 });
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=text-styles");
  const message = page.getByTestId("message-bot-bubble");
  const display = message.locator('math[display="block"]');
  await expect(display).toBeVisible();
  await expect(message.locator('math:not([display="block"])')).toHaveCount(2);

  await display.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "markdown-math");
});
