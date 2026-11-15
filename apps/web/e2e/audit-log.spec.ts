import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("an organization owner reads the audit log in organization settings", async ({
  page,
}, testInfo) => {
  await signup(page, `audit-log-${Date.now()}@rakazo.test`, "password12", "Audit Owner");
  await completeOnboarding(page);
  await rpc(page, "spaces/create", { name: "Audited space" });

  const settings = await openUserSettings(page, "organization");
  const log = settings.getByTestId("audit-log");
  await expect(log.getByRole("heading", { name: "Log" })).toBeVisible();
  await expect(log.getByRole("button", { name: "Export" })).toBeEnabled();
  await expect(log.getByRole("listitem").filter({ hasText: "space.created" })).toContainText(
    "Audited space",
  );
  await captureScreenshot(page, testInfo, "audit-log");
});
