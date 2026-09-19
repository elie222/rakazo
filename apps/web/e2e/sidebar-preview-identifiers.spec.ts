import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("sidebar preview preserves underscores in filenames", async ({ page }, testInfo) => {
  await signup(page, `preview-identifiers-${Date.now()}@rakazo.test`, "password12", "Preview Test");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Reports",
    title: "",
    description: "",
    computerMode: "team",
  });
  await page.goto(`/app/${bot.id}`);
  const composer = page.getByPlaceholder("Message Reports");
  await composer.fill("Saved **monthly_sales_report.csv**");
  const sent = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.press("Enter");
  await sent;
  const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
  await expect(row).toContainText("monthly_sales_report.csv");
  await expect(row).not.toContainText("**");
  await captureScreenshot(page, testInfo, "sidebar-preview-literal-underscores");
});
