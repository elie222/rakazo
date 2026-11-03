import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("failed run leaves a visible notice after its progress", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/chat-progress-messages.html?failed=1");
  const bubbles = page.getByTestId("message-bot-bubble");
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(0)).toHaveText("Checking your calendars…");
  await expect(bubbles.nth(1)).toHaveText(
    "Chief failed: TransientModelError: The model provider is temporarily unavailable. HTTP 502.",
  );
  await page.reload();
  await expect(bubbles.nth(1)).toContainText("Chief failed:");
  await captureScreenshot(page, testInfo, "failed-run-notice");
});
