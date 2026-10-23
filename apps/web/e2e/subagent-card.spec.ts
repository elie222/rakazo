import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, expectCardWidth, signup } from "./helpers";

test("a completed subagent card fills its width in wide and narrow chats", async ({
  page,
}, testInfo) => {
  await signup(page, `subagent-card-${Date.now()}@rakazo.test`, "password12", "Subagent Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("delegate to a helper: list three venue ideas");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("subagent-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("completed", { timeout: 30_000 });
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "subagent-card");
  await expectCardWidth(card, 420);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card).toBeVisible();
  await expectCardWidth(card, 420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
