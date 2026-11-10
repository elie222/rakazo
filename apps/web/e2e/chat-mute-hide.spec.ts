import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a chat row's ⋯ menu mutes and hides a chat, by pointer or keyboard", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `chat-mute-hide-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = await activeBotId(page);
  const scout = await rpc<{ id: string }>(page, "bots/create", { name: "Scout" });
  await rpc(page, "groups/create", { name: "Crew", botIds: [chiefId, scout.id] });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const chief = sidebar.getByRole("button", { name: /^Chief/ });
  const crew = sidebar.getByRole("button", { name: /^Crew/ });
  const chiefActions = sidebar.getByRole("button", { name: "Actions for Chief" });
  const crewActions = sidebar.getByRole("button", { name: "Actions for Crew" });
  await expect(crew).toBeVisible();

  // The "⋯" button stays out of sight until its row is hovered or focused.
  await expect(chiefActions).toHaveCSS("opacity", "0");
  await crew.hover();
  await expect(crewActions).toHaveCSS("opacity", "1");
  await crewActions.click();
  const crewMenu = page.getByRole("menu", { name: "Actions for Crew" });
  await expect(crewMenu).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-row-menu");
  const muted = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/mute") && response.ok(),
  );
  await crewMenu.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await muted;
  const crewMuted = crew.getByRole("img", { name: "Muted" });
  await expect(crewMuted).toBeVisible();
  await page.reload();
  await expect(crewMuted).toBeVisible();
  await page.mouse.move(800, 400);
  await captureScreenshot(page, testInfo, "muted-chat");

  // From the keyboard: the row, then its "⋯", which opens the same menu.
  await chief.focus();
  await page.keyboard.press("Tab");
  await expect(chiefActions).toBeFocused();
  await page.keyboard.press("Enter");
  const chiefMenu = page.getByRole("menu", { name: "Actions for Chief" });
  await expect(chiefMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chiefMenu).toHaveCount(0);
  await expect(chiefActions).toBeFocused();
  await page.keyboard.press("Enter");
  await chiefMenu.getByRole("menuitem", { name: "Hide", exact: true }).focus();
  await page.keyboard.press("Enter");

  // Out of the list, still one search away, and listed under Hidden until it is brought back.
  await expect(chief).toHaveCount(0);
  const hidden = sidebar.getByRole("button", { name: /^Hidden/ });
  await expect(hidden).toContainText("1");
  await page.reload();
  await expect(chief).toHaveCount(0);
  await hidden.click();
  await captureScreenshot(page, testInfo, "hidden-shelf");
  await sidebar.getByRole("button", { name: "Unhide Chief" }).focus();
  await page.keyboard.press("Enter");
  await expect(chief).toBeVisible();
  await expect(hidden).toHaveCount(0);
});
