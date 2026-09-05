import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];
const states = [
  { name: "active", live: true },
  { name: "complete", live: false },
];

test("chat shows only the bot response", async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await page.goto(`/e2e/fixtures/tool-activity-disclosure.html?live=${state.live ? 1 : 0}`);
      await expect(page.getByTestId("response")).toBeVisible();
      await expect(page.getByTestId("tool-activity")).toHaveCount(0);
      await expect(page.getByText("Working…")).toHaveCount(0);
      await expect(page.getByText("Done")).toHaveCount(0);
      await expect(page.getByText("Shell", { exact: false })).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `${state.name}-${viewport.name}`);
    }
  }
});
