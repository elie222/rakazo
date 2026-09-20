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
  // Stop as soon as the user message is committed so the assistant cannot
  // replace the short filename preview before the sidebar assertion.
  try {
    await rpc(page, "threads/send", {
      botId: bot.id,
      text: "Saved **monthly_sales_report.csv**; keep working",
    });
    await rpc(page, "threads/stop", { botId: bot.id });
    await page.goto(`/app/${bot.id}`);
    const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
    await expect(row).toContainText("monthly_sales_report.csv");
    await expect(row).not.toContainText("**");
    await captureScreenshot(page, testInfo, "sidebar-preview-literal-underscores");

    await rpc(page, "threads/send", {
      botId: bot.id,
      text: "<_ops_@example.test>; keep working",
    });
    await rpc(page, "threads/stop", { botId: bot.id });
    await page.reload();
    await expect(row).toContainText("_ops_@example.test");
    await expect(row).not.toContainText("<_ops_");
    await captureScreenshot(page, testInfo, "sidebar-preview-literal-autolink");
  } finally {
    await rpc(page, "threads/stop", { botId: bot.id });
  }
});
