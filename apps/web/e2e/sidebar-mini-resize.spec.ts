import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, rpc, signup } from "./helpers";

/** The sidebar has no collapse button; its edge and Ctrl/Cmd-B fold it to the avatar rail. */
async function toggleSidebar(page: Page) {
  await page.keyboard.press("ControlOrMeta+b");
}

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
  await expect(sidebar).toHaveCSS("width", "280px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const edge = (await handle.boundingBox())!;
  await page.mouse.down();
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await page.mouse.move(edge.x + 88, edge.y + 300, { steps: 10 });
  await expect(sidebar).toHaveCSS("width", "364px");
  await page.mouse.up();
  const preferredWidth = Math.round((await sidebar.boundingBox())!.width);
  expect(preferredWidth).toBeGreaterThan(354);
  await expect(handle).toHaveAttribute("aria-valuenow", String(preferredWidth));
  await captureScreenshot(page, testInfo, "sidebar-resized-expanded");

  await sidebar.getByTestId("sidebar-search-trigger").click();
  await sidebar.getByRole("textbox", { name: "Search", exact: true }).fill("no roster matches");
  await expect(row).toHaveCount(0);
  await toggleSidebar(page);
  await expect(sidebar).toHaveCSS("width", "80px");
  await expect(row).toHaveAccessibleName("Research");
  await expect(row).toHaveAccessibleDescription(/unread/);
  await toggleSidebar(page);
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toHaveValue(
    "no roster matches",
  );
  await sidebar.getByRole("textbox", { name: "Search", exact: true }).fill("");
  await toggleSidebar(page);
  await expect(sidebar).toHaveCSS("width", "80px");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/app/${bot.id}$`));
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator("[data-roster-preview]")).toHaveCount(0);
  await page.mouse.move(700, 450);
  await row.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: "Research" });
  await expect(tooltip).toBeVisible();
  await expect
    .poll(async () => {
      const label = await tooltip.boundingBox();
      const icon = await row.boundingBox();
      return label && icon ? label.x >= icon.x + icon.width : false;
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "sidebar-mini-avatar-rail");
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByTestId("account-menu-header")).toBeHidden();
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "80px");
  await toggleSidebar(page);
  await expect(sidebar).toHaveCSS("width", `${preferredWidth}px`);

  await handle.focus();
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "80px");
  await handle.hover({ position: { x: 4, y: 300 } });
  const miniEdge = (await handle.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(miniEdge.x + 240, miniEdge.y + 300, { steps: 12 });
  await page.mouse.up();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())!.width))
    .toBeGreaterThan(300);

  await toggleSidebar(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveCSS("width", "316px");
  await expect(sidebar.getByTestId("sidebar-search-trigger")).toBeVisible();
  await expect(sidebar.getByRole("textbox", { name: "Search", exact: true })).toHaveCount(0);
  await expect(row.locator("[data-roster-bot-name]")).toBeVisible();
});

test("sidebar resize follows RTL and reduced motion", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signup(page, `sidebar-rtl-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  // A viewport change renders the logical sidebar side after changing document direction.
  await page.setViewportSize({ width: 1300, height: 900 });
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await expect(sidebar).toHaveCSS("transition-property", "none");
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "312px");
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "80px");
  const row = sidebar.locator("[data-roster-bot-id]").first();
  await row.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toBeVisible();
  await expect
    .poll(async () => {
      const label = await tooltip.boundingBox();
      const icon = await row.boundingBox();
      return label && icon ? label.x + label.width <= icon.x : false;
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "sidebar-mini-avatar-rail-rtl");
  await handle.press("ArrowLeft");
  await expect(sidebar).toHaveCSS("width", "200px");
  const box = (await sidebar.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(1300);
});

test("narrow desktop keeps the chat width when both panels are open", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signup(page, `sidebar-panels-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await handle.focus();
  await handle.press("End");
  // The thread keeps 400px, so the widest sidebar here is 800 - 400.
  await expect(sidebar).toHaveCSS("width", "400px");
  await openBotPanelTab(page, "Computer");
  // Asked for in a window too narrow for all three, the panel takes the sidebar's room: the
  // sidebar steps down to the rail and nothing covers the thread.
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveCSS("position", "relative");
  await expect(sidebar).toHaveCSS("width", "80px");
  const chat = page.locator('[data-space-switch="main"]');
  await expect(panel).toHaveCSS("width", "300px");
  await expect(chat).toHaveCSS("width", "420px");
  await captureScreenshot(page, testInfo, "sidebar-narrow-panel-beside-rail");
  // Narrowing the window folds the panel first and gives the sidebar its room back.
  await page.setViewportSize({ width: 780, height: 900 });
  await expect(panel).toHaveAttribute("data-folded", "true");
  await expect(sidebar).toHaveCSS("width", "380px");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(400);
});

test("a desktop window keeps the avatar rail and the thread down to 480px", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signup(page, `sidebar-floor-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  const sidebar = page.getByTestId("bots-sidebar");
  const chat = page.locator('[data-space-switch="main"]');
  for (const [width, sidebarWidth] of [
    [700, 280],
    [640, 240],
    [560, 80],
    [480, 80],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS("width", `${sidebarWidth}px`);
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(400);
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  }
  await captureScreenshot(page, testInfo, "sidebar-rail-at-480");
  // The search button and the thread's top row share one line.
  const search = (await sidebar.getByTestId("sidebar-search-trigger").boundingBox())!;
  const title = (await page.getByTestId("bot-settings-trigger").boundingBox())!;
  expect(Math.abs(search.y + search.height / 2 - (title.y + title.height / 2))).toBeLessThan(3);
});

test("an open bot panel folds away as the window narrows and returns when it widens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signup(page, `panel-fold-${Date.now()}@rakazo.test`, "password12", "Sidebar Sample");
  await completeOnboarding(page);
  await openBotPanelTab(page, "Computer");
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveCSS("position", "relative");
  await page.setViewportSize({ width: 880, height: 900 });
  await expect(panel).toHaveAttribute("data-folded", "true");
  await expect(panel).toHaveCSS("width", "0px");
  const chat = page.locator('[data-space-switch="main"]');
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(400);
  await captureScreenshot(page, testInfo, "bot-panel-folded-narrow");
  // The chat name brings a folded panel back beside the thread, the sidebar stepping down to
  // the rail to make room, instead of closing it or covering the thread.
  const trigger = page.getByTestId("bot-settings-trigger");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(panel).not.toHaveAttribute("data-folded");
  await expect(panel).not.toHaveAttribute("data-overlay");
  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "80px");
  await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThanOrEqual(400);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(panel).not.toHaveAttribute("data-folded");
  await expect(panel).toHaveCSS("position", "relative");
});

test("sidebar snaps its layout during a held drag in both directions", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
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
  const captureFrame = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await sidebar.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { contentType: "image/png", path });
  };
  const handle = page.getByRole("separator", { name: "Resize bots sidebar" });
  await handle.focus();
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "80px");
  await captureFrame("sidebar-mini-tight-spacing");
  await handle.hover({ position: { x: 4, y: 300 } });
  const edge = (await handle.boundingBox())!;
  const origin = edge.x + 4;
  await page.mouse.down();
  for (const [distance, width, mini, frame] of [
    [48, 80, true, "01-mini-before-snap"],
    [112, 200, false, "02-expanded-on-snap"],
    [240, 320, false, "03-expanded-resizing"],
    [40, 80, true, "04-mini-on-snap-back"],
  ] as const) {
    await page.mouse.move(origin + distance, edge.y + 300);
    await expect(sidebar).toHaveCSS("width", `${width}px`);
    await expect(sidebar).toHaveAttribute("data-collapsed", String(mini));
    await captureFrame(`sidebar-drag-${frame}`);
  }
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "80px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "80px");
  await toggleSidebar(page);
  await expect(sidebar).toHaveCSS("width", "280px");
});

for (const platform of ["darwin", "linux"] as const) {
  test(`on the ${platform} desktop app the rail's search, the thread title and the panel close line up`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((platform) => {
      Object.defineProperty(window, "rakazoDesktop", {
        value: {
          platform,
          window: {
            close: async () => {},
            minimize: async () => {},
            toggleMaximize: async () => {},
            state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
          },
          oauth: { onCallback: () => () => {} },
        },
      });
    }, platform);
    await page.setViewportSize({ width: 1280, height: 800 });
    await signup(page, `rail-chrome-${platform}-${Date.now()}@rakazo.test`, "password12", "Rail");
    await completeOnboarding(page);
    const sidebar = page.getByTestId("bots-sidebar");
    await toggleSidebar(page);
    await expect(sidebar).toHaveCSS("width", "80px");
    await openBotPanelTab(page, "Computer");
    const middle = async (locator: ReturnType<Page["locator"]>) => {
      const box = (await locator.boundingBox())!;
      return box.y + box.height / 2;
    };
    const search = await middle(sidebar.getByTestId("sidebar-search-trigger"));
    for (const other of [
      page.getByTestId("bot-settings-trigger"),
      page.getByRole("button", { name: "Close panel" }),
    ]) {
      await expect.poll(async () => Math.abs((await middle(other)) - search)).toBeLessThan(3);
    }
    await captureScreenshot(page, testInfo, `rail-top-row-${platform}`);
  });
}
