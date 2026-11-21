import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "../helpers/helpers";

test("the app rail and chat list keep one navigation hierarchy", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `sidebar-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });

  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill("A first chat message");
  await composer.press("Enter");
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await expect(page.getByText("A first chat message", { exact: true })).toBeVisible();

  const rail = page.getByTestId("app-rail");
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  const chats = rail.getByRole("link", { name: "Chats" });
  const activity = rail.getByRole("button", { name: "Activity" });
  await expect(rail).toBeVisible();
  await expect(chats).toHaveAttribute("aria-current", "page");
  await expect(activity).toBeVisible();
  await expect(rail.getByRole("link", { name: "Artifacts" })).toBeVisible();
  const chatRow = page.locator("[data-roster-bot-id]").first();
  const rowBox = await chatRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(56);
  // The rail starts as icons; its labels fold out without taking the list with them.
  await rail.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(rail.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(rail.getByText("Chats", { exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(rail.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // Activity is a list mode; returning to Chats restores the roster.
  await activity.click();
  await expect(
    page.getByTestId("bots-sidebar").getByText("Activity", { exact: true }).first(),
  ).toBeVisible();
  await chats.click();
  await expect(
    page.getByTestId("bots-sidebar").getByText("Chats", { exact: true }).first(),
  ).toBeVisible();

  // The list can go away; the rail remains and brings it back.
  await page.getByRole("button", { name: "Hide chat list" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const list = page.getByTestId("bots-sidebar");
  await expect(list).toHaveAttribute("aria-hidden", "true");
  await expect(list).toHaveAttribute("inert", "");
  await expect(rail).toBeVisible();
  await rail.getByRole("button", { name: "Show chat list" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const element = document.querySelector('[data-testid="bots-sidebar"]');
        return element ? getComputedStyle(element).left : null;
      }),
    )
    .toBe("56px");
  const final = await page.evaluate(() => {
    const railElement = document.querySelector('[data-testid="app-rail"]') as HTMLElement;
    return {
      railWidth: getComputedStyle(railElement).width,
      railText: railElement.textContent,
    };
  });
  expect(final.railWidth).toBe("56px");
  expect(final.railText).toContain("Chats");
  expect(final.railText).toContain("Activity");
  await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
  const hideBox = await page.getByRole("button", { name: "Hide chat list" }).boundingBox();
  expect(hideBox).not.toBeNull();
  expect(hideBox!.x).toBeGreaterThanOrEqual(56);
  expect(hideBox!.x + hideBox!.width).toBeLessThanOrEqual(536);

  // Activity from another page returns to the chat shell, where its list lives.
  await page.getByRole("button", { name: "Hide chat list" }).click();
  await rail.getByRole("link", { name: "Artifacts" }).click();
  await expect(page).toHaveURL(/\/app\/artifacts/);
  // Restoring a hidden list also returns to the chat shell from any page.
  await page.getByTestId("show-chat-list").click();
  await expect(page).not.toHaveURL(/\/app\/artifacts/);
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await activity.click();
  await expect(page).not.toHaveURL(/\/app\/artifacts/);
  await expect(
    page.getByTestId("bots-sidebar").getByText("Activity", { exact: true }).first(),
  ).toBeVisible();
  await chats.click();

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `chat-sidebar-${theme}`);
  }

  // Below md the rail is gone, so the drawer keeps its own Activity entry.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileActivity = page.getByRole("button", { name: "Activity" });
  await expect(mobileActivity).toBeVisible();
  await mobileActivity.click();
  await expect(
    page.getByTestId("bots-sidebar").getByText("Activity", { exact: true }).first(),
  ).toBeVisible();
});

test("a row's More button opens the chat menu and leaves the row clickable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `sidebar-more-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const first = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId: first });
  const second = await createNamedBot(page, "Second chat");
  await page.goto(`/app/${first}`);

  const row = page
    .locator('[data-slot="list-row"]')
    .filter({ has: page.locator(`[data-roster-bot-id="${second}"]`) });
  await row.hover();
  const more = row.getByRole("button", { name: /^Actions for / });
  await expect(more).toBeVisible();
  await more.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Pin" })).toBeVisible();

  // Escape closes the menu and returns focus to the control that opened it.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // The button sits beside the link, so the row still navigates.
  await row.locator(`[data-roster-bot-id="${second}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${second}$`));
});
