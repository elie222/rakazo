import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("archived chats wait in Settings and restore to the sidebar", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `archived-settings-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Trip Planner",
    color: "#F5A03C",
    notifyOnFinish: true,
  });
  await rpc(page, "bots/archive", { botId: bot.id });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByRole("button", { name: /^Trip Planner/ })).toHaveCount(0);
  await expect(sidebar.getByText("Archived", { exact: true })).toHaveCount(0);

  const settings = await openUserSettings(page, "archived");
  await expect(settings.getByText("Trip Planner", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "archived-settings");

  await settings.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(settings.getByText("No archived chats")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sidebar.getByRole("button", { name: /^Trip Planner/ })).toBeVisible();
});
