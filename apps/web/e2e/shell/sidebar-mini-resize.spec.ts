import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  rpc,
  signup,
} from "../helpers/helpers";

test("sidebar rail keeps chats interactive and remembers a dragged width", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `sidebar-rail-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const bot = await rpc<{ id: string }>(page, "bots/create", {
    name: "Research",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "threads/markUnread", { botId: bot.id });
  await page.reload();

  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const row = page.locator(`[data-roster-bot-id="${bot.id}"]`);
  const hide = sidebar.getByRole("button", { name: "Hide chat list" });
  const show = page.getByTestId("show-chat-list");

  await expect(sidebar).toHaveCSS("width", "316px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const edge = (await handle.boundingBox())!;
  await page.mouse.down();
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await page.mouse.move(edge.x + 88, edge.y + 300, { steps: 10 });
  await expect(sidebar).toHaveCSS("width", "400px");
  await page.mouse.up();
  const preferredWidth = Math.round((await sidebar.boundingBox())!.width);
  expect(preferredWidth).toBeGreaterThan(390);
  await expect(handle).toHaveAttribute("aria-valuenow", String(preferredWidth));
  await captureScreenshot(page, testInfo, "sidebar-resized-expanded");

  await sidebar.getByTestId("sidebar-search-trigger").click();
  await sidebar.getByRole("textbox", { name: "Search", exact: true }).fill("no roster matches");
  await expect(row).toHaveCount(0);

  // Hiding the list removes it from focus and assistive technology; the rail brings it back.
  await hide.click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(show).toBeFocused();
  await show.click();
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toHaveValue(
    "no roster matches",
  );
  await expect(sidebar.getByTestId("sidebar-search-trigger")).toBeFocused();
  await sidebar.getByRole("textbox", { name: "Search", exact: true }).fill("");

  await hide.click();
  await show.click();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/${bot.id}$`));
  await expect(row).toHaveAttribute("aria-current", "page");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Connect apps", exact: true }).last().click();
  await expect(page.getByTestId("account-menu-header")).toBeHidden();
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();

  await page.reload();
  await expect(sidebar).toHaveCSS("width", `${preferredWidth}px`);
});

test("keyboard resize keeps focus and hands collapse to the rail", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await signup(page, `sidebar-keys-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const show = page.getByTestId("show-chat-list");

  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "284px");
  await handle.press("Home");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(show).toBeFocused();

  await show.click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect(sidebar.getByTestId("sidebar-search-trigger")).toBeFocused();
  await handle.focus();
  await handle.press("End");
  await expect(sidebar).toHaveCSS("width", "480px");
});

test("narrow desktop keeps the chat width when both panels are open", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signup(page, `sidebar-panels-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  // An expanded rail takes 220px, leaving the chat's 320px minimum before the list grows.
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await handle.focus();
  await handle.press("End");
  await expect(sidebar).toHaveCSS("width", "260px");
  await openBotPanel(page);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveCSS("position", "absolute");
  const chat = page.locator('[data-space-switch="main"]');
  await expect(chat).toHaveCSS("width", "320px");
  await expect(panel).toHaveCSS("width", "320px");
  await captureScreenshot(page, testInfo, "sidebar-narrow-panel-overlay");
  await handle.focus();
  await handle.press("Home");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("show-chat-list")).toBeFocused();
  // The rail keeps the panel overlaying the chat, which still keeps the composer's minimum.
  await expect(panel).toHaveCSS("position", "absolute");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(320);
});

test("sidebar snaps its layout during a held drag", async ({ page }) => {
  await signup(page, `sidebar-snaps-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  for (const name of ["Research", "Notes", "Planner"]) {
    await rpc(page, "bots/create", {
      name,
      description: "",
      instructions: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const show = page.getByTestId("show-chat-list");

  await expect(sidebar).toHaveCSS("width", "316px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const edge = (await handle.boundingBox())!;
  const origin = edge.x + 4;
  await page.mouse.down();
  await page.mouse.move(origin - 200, edge.y + 300);
  // The handle stays mounted while the pointer is down, so the release can still commit.
  await expect(handle).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.mouse.up();
  await expect(handle).toHaveCount(0);
  await expect(show).toBeVisible();

  await show.click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect(sidebar).toHaveCSS("width", "316px");
});

test("resizes in the visual direction for RTL and hands collapse to the rail", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await signup(page, `sidebar-rtl-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  const show = page.getByTestId("show-chat-list");
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "348px");
  await handle.press("Home");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await expect(show).toBeFocused();
  await show.click();
  await expect
    .poll(async () => {
      const box = (await sidebar.boundingBox())!;
      const rail = (await page.getByTestId("app-rail").boundingBox())!;
      return Math.round(box.x + box.width) - Math.round(rail.x);
    })
    .toBe(0);
});
