import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("an organization owner opens the activity log from the organization menu", async ({
  page,
}, testInfo) => {
  await signup(page, `audit-log-${Date.now()}@rakazo.test`, "password12", "Audit Owner");
  await completeOnboarding(page);
  await rpc(page, "spaces/create", { name: "Audited space" });

  const settings = await openUserSettings(page, "organization");
  // The organization page stays about the organization; the log is behind the header menu.
  await expect(settings.getByTestId("audit-log")).toHaveCount(0);
  await settings
    .getByTestId("settings-header")
    .getByRole("button", { name: "Organization options" })
    .click();
  await page.getByRole("menuitem", { name: "Activity log" }).click();

  const log = settings.getByTestId("audit-log");
  await expect(log.getByRole("heading", { name: "Activity log" })).toBeVisible();
  await expect(log.getByRole("button", { name: "Export" })).toBeEnabled();
  await expect(log.getByRole("listitem").filter({ hasText: "space.created" })).toContainText(
    "Audited space",
  );
  await captureScreenshot(page, testInfo, "audit-log");

  await log.getByRole("button", { name: "Back" }).click();
  await expect(settings.getByTestId("organization-settings")).toBeVisible();
  await expect(settings.getByTestId("audit-log")).toHaveCount(0);
});
