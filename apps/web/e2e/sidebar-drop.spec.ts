import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("drag bots into collapsed sections, another section's row, and group chats", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-drop-${Date.now()}@rakazo.test`, "password12", "Sidebar Drop");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const alpha = await rpc<{ id: string }>(page, "bots/create", {
    name: "Alpha",
    computerMode: "team",
  });
  const beta = await rpc<{ id: string }>(page, "bots/create", {
    name: "Beta",
    computerMode: "team",
  });
  const section = await rpc<{ id: string }>(page, "botSections/create", {
    botId: alpha.id,
    name: "Projects",
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Review room",
    botIds: [alpha.id, beta.id],
  });
  await page.reload();
  const sidebar = page.locator("aside").first();
  const sectionRows = sidebar.locator(`[data-sidebar-group="section:${section.id}"]`);
  const chief = sidebar.locator(`[data-roster-bot-id="${chiefId}"]`);
  await sectionRows.getByRole("button", { name: "Collapse Projects", exact: true }).click();
  await chief.dragTo(sectionRows.getByRole("button", { name: "Expand Projects", exact: true }));
  await expect
    .poll(async () => {
      const bot = await rpc<{ sectionId: string | null }>(page, "bots/get", { botId: chiefId });
      return bot.sectionId;
    })
    .toBe(section.id);
  await sectionRows.getByRole("button", { name: "Expand Projects", exact: true }).click();
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  await sidebar.locator(`[data-roster-bot-id="${beta.id}"]`).dragTo(chief);
  await expect(sectionRows.locator(`[data-roster-bot-id="${beta.id}"]`)).toBeVisible();
  await captureScreenshot(page, testInfo, "dragged-bots-in-section");
  // A failed save must leave the section assignment unchanged and surface an error.
  await page.route(
    "**/rpc/bots/update",
    async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    },
    { times: 1 },
  );
  await chief.dragTo(sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }));
  await expect(page.getByRole("alert").filter({ hasText: "Internal Server Error" })).toBeVisible();
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  // Moving the last bot out leaves an empty section as a usable drop target.
  await chief.dragTo(sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }));
  await expect(
    sidebar
      .locator('[data-sidebar-group="unassigned"]')
      .locator(`[data-roster-bot-id="${chiefId}"]`),
  ).toBeVisible();
  await sidebar
    .locator(`[data-roster-bot-id="${alpha.id}"]`)
    .dragTo(sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }));
  // Wait for the save and roster refresh before dragging a row whose position changes.
  await expect(
    sidebar
      .locator('[data-sidebar-group="unassigned"]')
      .locator(`[data-roster-bot-id="${alpha.id}"]`),
  ).toBeVisible();
  await sidebar
    .locator(`[data-roster-bot-id="${beta.id}"]`)
    .dragTo(sidebar.getByRole("button", { name: "Collapse Unassigned", exact: true }));
  await expect(sectionRows.locator("[data-roster-bot-id]")).toHaveCount(0);
  await chief.dragTo(sectionRows.getByRole("button", { name: "Collapse Projects", exact: true }));
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  // Joining a chat does not move the bot out of its section.
  await sidebar.getByRole("button", { name: /^Review room/ }).click();
  await chief.dragTo(sidebar.getByRole("button", { name: /^Review room/ }));
  await expect
    .poll(async () => {
      const room = await rpc<{ members: { botId: string }[] }>(page, "groups/get", {
        groupId: group.id,
      });
      return room.members.map((member) => member.botId).sort();
    })
    .toEqual([alpha.id, beta.id, chiefId].sort());
  await page.reload();
  await expect(sectionRows.locator(`[data-roster-bot-id="${chiefId}"]`)).toBeVisible();
  await captureScreenshot(page, testInfo, "dragged-bot-joins-group");
});
