import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("creates an API key in Settings, shows it once, and deletes it", async ({
  page,
}, testInfo) => {
  await signup(page, `api-keys-${Date.now()}@rakazo.test`, "password12", "API keys");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  const group = settings.getByTestId("api-keys");
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("button", { name: "Create key" }).click();
  await group.getByLabel("Key name").fill("Laptop script");
  await group.getByRole("button", { name: "Create", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  const created = group.getByTestId("api-key-created");
  await expect(created.or(confirm)).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Password", { exact: true }).fill("password12");
    await confirm.getByRole("button", { name: "Continue" }).click();
  }
  await expect(created).toContainText("rkz_");
  const remove = group.getByRole("button", { name: "Delete Laptop script" });
  await expect(remove).toBeVisible();
  await captureScreenshot(page, testInfo, "api-keys-settings");

  await remove.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(remove).toHaveCount(0);
});
