import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("creates an API key, shows it once, and revokes it", async ({ page }, testInfo) => {
  const password = "password12";
  await signup(page, `service-keys-${Date.now()}@rakazo.test`, password, "Keys");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-serviceKeys").click();
  await settings.getByLabel("Name", { exact: true }).fill("Nightly report");
  await settings.getByRole("checkbox", { name: "prompts:write", exact: true }).check();
  await settings.getByRole("button", { name: "Create key", exact: true }).click();

  // A fresh sign-in may already count as confirmed; otherwise the password is asked for.
  const notice = settings.getByText("Copy this key now. It won't be shown again.");
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(notice.or(confirm)).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByLabel("Password", { exact: true }).fill(password);
    await confirm.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await expect(notice).toBeVisible();
  await expect(settings.locator("code")).toHaveText(/^rks_/);
  const key = settings.getByRole("listitem").filter({ hasText: "Nightly report" });
  await expect(key).toContainText("bots:read, prompts:write");
  await expect(key).toContainText("Never used");
  await captureScreenshot(page, testInfo, "service-key-created");

  // A second key replaces the notice; revoking the first leaves the second to copy.
  await settings.getByLabel("Name", { exact: true }).fill("Backup");
  await settings.getByRole("button", { name: "Create key", exact: true }).click();
  const backup = settings.getByRole("listitem").filter({ hasText: "Backup" });
  await expect(backup).toBeVisible();
  const second = await settings.locator("code").textContent();
  await key.getByRole("button", { name: "Revoke Nightly report", exact: true }).click();
  await expect(key).toContainText("Revoked");
  await expect(notice).toBeVisible();
  await expect(settings.locator("code")).toHaveText(second ?? "");

  await backup.getByRole("button", { name: "Revoke Backup", exact: true }).click();
  await expect(backup).toContainText("Revoked");
  await expect(notice).toBeHidden();
});
