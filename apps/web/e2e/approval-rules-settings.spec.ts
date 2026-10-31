import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("creates and changes an individual tool permission", async ({ page }, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "confirmations");
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  await settings.getByRole("textbox", { name: "Tool name" }).fill("write_file");
  await settings.locator("form").getByRole("button", { name: "Save", exact: true }).click();
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
