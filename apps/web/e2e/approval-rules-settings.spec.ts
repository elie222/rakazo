import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("adds a tool rule and switches it between Ask and Block", async ({ page }, testInfo) => {
  await signup(page, `approval-rules-${Date.now()}@rakazo.test`, "password12", "Permissions");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await settings.getByRole("button", { name: "Add rule", exact: true }).click();
  const toolName = settings.getByRole("textbox", { name: "Tool name" });
  await toolName.fill("write_file");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
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
  await captureScreenshot(page, testInfo, "approval-rules-added");
});
