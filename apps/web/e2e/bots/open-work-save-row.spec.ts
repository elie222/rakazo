import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "../helpers/helpers";

test("the bot adding to its open work leaves a removable row in the chat", async ({
  page,
}, testInfo) => {
  await signup(page, `open-work-row-${Date.now()}@rakazo.test`, "password12", "Open work row");
  await completeOnboarding(page);

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("add to your open work: Compare the two vendors");
  await page.keyboard.press("Enter");

  const row = page.getByTestId("open-work-event-row");
  const remove = row.getByRole("button", { name: "Remove" });
  await expect(row).toHaveText('Added to open work "Compare the two vendors"', { timeout: 30_000 });
  await expect(remove).toBeVisible();
  await captureScreenshot(page, testInfo, "open-work-save-row");

  // Removing it there drops the item; the row stays as the record of what happened.
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(row).toHaveText('Added to open work "Compare the two vendors"');
});
