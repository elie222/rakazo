import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const ORDER_KEY = "rakazo.botsSidebarOrder";

test("recent activity order lists the latest chats first without sections", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-order-${Date.now()}@rakazo.test`, "password12", "Sidebar Order");
  await completeOnboarding(page);
  const alpha = await rpc<{ id: string }>(page, "bots/create", {
    name: "Alpha",
    computerMode: "team",
  });
  const beta = await rpc<{ id: string }>(page, "bots/create", {
    name: "Beta",
    computerMode: "team",
  });
  const section = await rpc<{ id: string }>(page, "botSections/create", {
    botId: beta.id,
    name: "Projects",
  });
  // Beta talks first, then Alpha, so Alpha holds the newest message.
  for (const botId of [beta.id, alpha.id]) {
    await rpc(page, "threads/send", { botId, text: "status?" });
    await rpc(page, "threads/stop", { botId });
  }
  await page.reload();

  const sidebar = page.getByTestId("bots-sidebar");
  const sectionRows = sidebar.locator(`[data-sidebar-group="section:${section.id}"]`);
  await expect(sectionRows).toBeVisible();

  const settings = await openUserSettings(page);
  const activity = settings.getByTestId("bots-sidebar-order-activity");
  await activity.scrollIntoViewIfNeeded();
  await activity.click();
  await expect(activity).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), ORDER_KEY))
    .toBe("activity");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await expect(sectionRows).toHaveCount(0);
  const rosterIds = () =>
    sidebar
      .locator("[data-roster-bot-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-roster-bot-id")));
  await expect.poll(async () => (await rosterIds()).slice(0, 2)).toEqual([alpha.id, beta.id]);
  // The order is computed, so rows can no longer be dragged by hand.
  await expect(sidebar.locator(`[data-roster-bot-id="${alpha.id}"]`)).toHaveAttribute(
    "draggable",
    "false",
  );
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-order-activity");

  await page.reload();
  await expect(sectionRows).toHaveCount(0);
  await expect.poll(async () => (await rosterIds()).slice(0, 2)).toEqual([alpha.id, beta.id]);
});
