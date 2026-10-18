import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a group a bot creates after approval appears in the sidebar without a reload", async ({
  page,
}, testInfo) => {
  await signup(page, `fleet-groups-${Date.now()}@rakazo.test`, "password12", "Fleet Groups");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  await rpc(page, "bots/update", { botId: chiefId, fleetManagement: true });
  for (const name of ["Alpha", "Beta"]) {
    await rpc(page, "bots/create", { name, title: "", description: "", notifyOnFinish: true });
  }

  const sidebar = page.locator("aside").first();
  const composer = page.getByPlaceholder("Message Chief");
  await expect(composer).toBeEnabled();
  await composer.fill("create a group named Crew with Alpha, Beta");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Create group “Crew”?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Members: Alpha, Beta", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Crew/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "fleet-create-group-approval");

  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: /^Crew/ })).toBeVisible({ timeout: 30_000 });
});
