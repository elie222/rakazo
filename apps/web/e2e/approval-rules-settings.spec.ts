import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("changes an individual tool permission", async ({ page }, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  await rpc(page, "approvalRules/set", {
    scope: "account",
    matchKind: "tool",
    matchValue: "write_file",
    effect: "require_approval",
  });
  const settings = await openUserSettings(page, "confirmations");
  const rule = settings.getByRole("group", { name: "Write file", exact: true });
  await expect(rule.getByRole("button", { name: "Ask", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rule.getByRole("button", { name: "Block", exact: true }).click();
  await expect(rule.getByRole("button", { name: "Block", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rule.getByRole("button", { name: "Ask", exact: true }).click();
  await captureScreenshot(page, testInfo, "individual-tool-approval");
});
