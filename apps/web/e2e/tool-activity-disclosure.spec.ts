import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];
const states = [
  { name: "active", phase: "live" },
  { name: "complete", phase: "done" },
];

test("chat shows only the bot response when tool activity is off", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.showToolActivity", "off"));
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await page.goto(`/e2e/fixtures/tool-activity.html?view=thread&phase=${state.phase}`);
      await expect(page.getByTestId("message-user-bubble")).toBeVisible();
      if (state.phase === "done") {
        await expect(page.getByTestId("message-bot-bubble")).toHaveText("Tuesday at 2 pm is free.");
      } else {
        await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
      }
      await expect(page.getByTestId("tool-activity")).toHaveCount(0);
      await expect(page.getByTestId("tool-activity-line")).toHaveCount(0);
      await expect(page.getByText("Working…", { exact: false })).toHaveCount(0);
      await expect(page.getByText("Done ·", { exact: false })).toHaveCount(0);
      await expect(page.getByText("Open calendar", { exact: false })).toHaveCount(0);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `${state.name}-${viewport.name}`);
    }
  }
});
