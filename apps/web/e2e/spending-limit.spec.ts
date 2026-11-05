import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("shows the spending limit once a card is saved, and sets a monthly limit", async ({
  page,
}, testInfo) => {
  await signup(page, `spending-limit-${Date.now()}@rakazo.test`, "password12", "Spender");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByTestId("approval-mode")).toBeVisible();
  // Nothing can pay yet, so there is nothing to limit.
  await expect(settings.getByTestId("spending-limit")).toHaveCount(0);

  await settings.getByTestId("settings-nav-vault").click();
  await settings.getByTestId("vault").getByTestId("vault-new").click();
  await page.getByTestId("vault-new-card").click();
  const editor = page.getByTestId("vault-editor");
  await editor.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await editor.getByLabel("Expiry", { exact: true }).fill("0830");
  await editor.getByLabel("Security code", { exact: true }).fill("123");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await settings.getByTestId("settings-nav-confirmations").click();
  const limit = settings.getByTestId("spending-limit");
  await expect(limit).toContainText("None");
  await limit.getByRole("button", { name: "Set", exact: true }).click();
  await limit.getByRole("textbox", { name: "Amount" }).fill("200");
  await captureScreenshot(page, testInfo, "spending-limit-edit");
  await limit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(limit).toContainText("$200.00 a month");
  await expect(limit).toContainText("$0.00 spent this month");
  await captureScreenshot(page, testInfo, "spending-limit-set");
});
