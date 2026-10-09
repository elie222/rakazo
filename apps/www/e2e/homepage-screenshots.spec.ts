import type { Page, TestInfo } from "@playwright/test";
import { test } from "@playwright/test";

/** Visual record for the CI screenshot gallery. No content assertions. */
async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

test("homepage screenshots", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.waitForLoadState("load");
  await captureScreenshot(page, testInfo, "01-marketing-homepage");

  await page.locator("[data-get-started-open]").first().click();
  await page.locator("dialog[data-get-started-dialog]").waitFor({ state: "visible" });
  await captureScreenshot(page, testInfo, "02-marketing-get-started");

  await page.goto("/zh/");
  await page.waitForLoadState("load");
  await captureScreenshot(page, testInfo, "03-marketing-homepage-zh");
});
