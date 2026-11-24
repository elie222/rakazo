import { expect, test } from "@playwright/test";
import { connectionToolRuleValue } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

test("picks a tool for a rule and moves it from Always ask to Blocked", async ({
  page,
}, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  await page.getByRole("combobox", { name: "Search tools" }).fill("write");
  await page.getByRole("option", { name: "Write file", exact: true }).click();
  const asking = settings.getByTestId("approval-rules-require_approval");
  await expect(asking).toContainText("Write file");
  await settings
    .getByRole("group", { name: "Write file", exact: true })
    .getByRole("button", { name: "Block", exact: true })
    .click();
  await expect(settings.getByTestId("approval-rules-deny")).toContainText("Write file");
  await expect(asking).toHaveCount(0);
  await captureScreenshot(page, testInfo, "approval-rules-added");
});

test("shows the connection and exact path beside a scoped rule", async ({ page }, testInfo) => {
  await signup(page, `scoped-approval-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const path = "tools.notes.renameNote";
  await rpc(page, "approvalRules/set", {
    scope: "account",
    effect: "always_allow",
    matchKind: "connection_tool",
    matchValue: connectionToolRuleValue("fixture-connection", path, "Notes Personal"),
  });

  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  const allowed = settings.getByTestId("approval-rules-always_allow");
  await expect(
    allowed.getByText("Notes rename note · Notes Personal", { exact: true }),
  ).toBeVisible();
  await expect(allowed.getByText(path, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "scoped-approval-rule");
});

test("shows the scope of an approval that saves multiple rules", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=approvals&theme=light");
  await expect(page.getByTestId("ask-detail").filter({ hasText: "Notes Personal" })).toBeVisible();
  const always = page.getByRole("button", { name: "Always allow these tools" });
  await always.scrollIntoViewIfNeeded();
  await expect(always).toBeEnabled();
  await captureScreenshot(page, testInfo, "scoped-batch-approval");
});
