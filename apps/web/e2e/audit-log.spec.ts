import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("audit log lists the owner's own actions", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `settings-audit-${stamp}@rakazo.test`, "password12", "Audit log");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "audit");
  await expect(settings).toHaveAttribute("data-settings-section", "audit");
  const log = settings.getByTestId("audit-log-settings");
  await expect(log.getByRole("button", { name: "Export" })).toBeVisible();
  await expect(log.getByRole("row").nth(1)).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-audit-log");
});
