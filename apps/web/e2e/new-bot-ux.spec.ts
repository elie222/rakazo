import { expect, test } from "@playwright/test";
import { organicAvatarFamily } from "@rakazo/core";
import { captureScreenshot, completeOnboarding, createBotFromPicker, rpc, signup } from "./helpers";

test("create opens dialog, then empty chat; picker lists bots; sidebar collapses", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `new-bot-ux-${stamp}@rakazo.test`, "password12", "New Bot UX");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const picker = page.getByTestId("bot-create-picker");
  await expect(page.getByTestId("create-menu-trigger")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(picker.getByPlaceholder("Search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await page.getByTestId("create-menu-trigger").click();
  await expect(picker).toBeVisible();
  await expect(picker.getByPlaceholder("Search")).toBeVisible();
  await expect(picker.getByTestId("create-new-bot")).toBeVisible();
  await expect(picker.getByText("Chief", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "plus-picker-bots");

  await picker.getByPlaceholder("Search").focus();
  await page.keyboard.press("ArrowDown");
  await expect(picker.locator('[data-slot="command-item"][data-selected="true"]')).toContainText(
    "New group chat",
  );
  await captureScreenshot(page, testInfo, "plus-picker-highlight");

  await picker.getByTestId("create-new-bot").click();
  const createDialog = page.getByTestId("create-bot-dialog");
  await expect(createDialog).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  const name = createDialog.getByPlaceholder("Name your Bot");
  await expect(name).toBeFocused();
  const create = createDialog.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeDisabled();
  await name.fill("   ");
  await expect(create).toBeDisabled();

  await name.fill("New Bot");
  const wedge = createDialog.getByRole("button", { name: "wedge", exact: true });
  await wedge.click();
  await createDialog.getByRole("button", { name: "Color #10B981", exact: true }).click();
  await expect(wedge).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "create-bot-dialog");

  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/create") && response.ok(),
  );
  await name.press("Enter");
  await created;
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(createDialog).toBeHidden();
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  const newBotId = page.url().split("/").pop()!;
  const afterCreate = await rpc<Array<{ id: string; color: string; computerMode: string }>>(
    page,
    "bots/list",
    {},
  );
  expect(afterCreate.find((bot) => bot.id === newBotId)).toMatchObject({
    color: "#10B981::shape_1",
    computerMode: "team",
  });
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-chat-sidepanel-closed");

  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  const edge = page.getByTestId("bots-sidebar-edge");
  await expect(edge).toBeVisible();
  const restore = page.getByTestId("restore-bots-sidebar");
  await expect(restore).toBeVisible();
  await captureScreenshot(page, testInfo, "bots-sidebar-collapsed");

  await restore.click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "false");
  await expect(restore).toHaveCount(0);

  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");

  await expect(page.getByTestId("bots-sidebar")).toHaveCSS("width", "72px");
  await edge.hover();
  const box = await edge.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 180, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "false");
  await captureScreenshot(page, testInfo, "bots-sidebar-expanded");

  await page.getByTestId("create-menu-trigger").click();
  await expect(picker).toBeVisible();

  const spaceInfo = picker.getByTestId("picker-info-space");
  await expect.poll(() => spaceInfo.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await picker.getByTestId("create-new-space").hover();
  await expect.poll(() => spaceInfo.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await spaceInfo.hover();
  const spaceTooltip = page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: "Private workspace with its own bots and groups." });
  await expect(spaceTooltip).toBeVisible();
  await captureScreenshot(page, testInfo, "picker-space-info-tooltip");
  await page.mouse.move(0, 0);
  await expect(spaceTooltip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  // An organic body picked in the dialog is the body the new bot gets.
  await page.getByTestId("create-menu-trigger").click();
  await picker.getByTestId("create-new-bot").click();
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Shape 3", exact: true }).click();
  const family = Number(
    await createDialog.locator(".rakazo-organic-avatar").first().getAttribute("data-shape-family"),
  );
  await createDialog.getByPlaceholder("Name your Bot").fill("Organic Bot");
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.getByPlaceholder("Message Organic Bot")).toBeVisible();
  expect(organicAvatarFamily(page.url().split("/").pop()!)).toBe(family);
});

test("a stale roster refresh started before creation keeps the new bot selected", async ({
  page,
}, testInfo) => {
  await signup(page, `stale-create-${Date.now()}@rakazo.test`, "password12", "Stale Create");
  await completeOnboarding(page);
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  let markReady!: () => void;
  let releaseList!: () => void;
  let releaseStart!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route(
    "**/rpc/spaces/list",
    async (route) => {
      const response = await route.fetch();
      markReady();
      await listGate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  // Keep the post-create refresh from masking the stale response.
  await page.route("**/rpc/onboarding/start", async (route) => {
    await startGate;
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ready;
  try {
    await createBotFromPicker(page, { name: "Later Bot" });
    const composer = page.getByRole("combobox", { name: "Message Later Bot", exact: true });
    await expect(composer).toBeEditable();
    const createdPath = new URL(page.url()).pathname;
    const delivered = page.waitForResponse("**/rpc/spaces/list");
    releaseList();
    await (await delivered).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(composer).toBeEditable();
    expect(new URL(page.url()).pathname).toBe(createdPath);
    await captureScreenshot(page, testInfo, "new-bot-stale-refresh");
    // The create flow's final refresh follows the stale response, without masking a redirect.
    const freshRoster = page.waitForResponse("**/rpc/spaces/list");
    releaseStart();
    await freshRoster;
    await expect(page).toHaveURL((url) => url.pathname === createdPath);
    await expect(composer).toBeEditable();
  } finally {
    releaseList();
    releaseStart();
  }
});

test("later bot waits before showing the focus card; sending cancels it", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `focus-delay-${stamp}@rakazo.test`, "password12", "Focus Delay");
  await completeOnboarding(page);
  // First bot from onboarding shows the focus card immediately.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();

  await page.clock.install();
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);

  await page.clock.fastForward(9_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(1_500);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();

  await createBotFromPicker(page, { name: "Later Bot" });
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  // Closing the create panel can precede the new thread loading; the previous
  // bot's composer must not receive this draft.
  const composer = page.getByRole("combobox", { name: "Message Later Bot", exact: true });
  await expect(composer).toBeEditable();
  await composer.fill("I'll set this up myself");
  // Send must finish before the delay is advanced: cancel runs after a successful
  // RPC, and promptFocus will still post if the clock fires while send is in flight.
  const sent = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.press("Enter");
  await sent;
  // Scope to the user bubble: the assistant reply can echo this phrase as a substring.
  await expect(
    page
      .getByTestId("transcript")
      .getByTestId("message-user-bubble")
      .getByText("I'll set this up myself", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(12_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
});

test("creation actions stay visible above a long bot list", async ({ page }, testInfo) => {
  await signup(page, `create-menu-${Date.now()}@rakazo.test`, "password12", "Create menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  for (let index = 0; index < 12; index++) {
    await rpc(page, "bots/create", {
      name: `Helper ${index + 1}`,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  await page.reload();
  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("bot-create-picker");
  const group = picker.getByTestId("create-new-group");
  const space = picker.getByTestId("create-new-space");
  const firstBot = picker.locator('[data-testid^="picker-bot-"]').first();
  await expect(picker.locator('[data-testid^="picker-bot-"]')).toHaveCount(13);
  const groupBox = await group.boundingBox();
  const botBox = await firstBot.boundingBox();
  expect(groupBox!.y).toBeLessThan(botBox!.y);
  await picker.locator('[data-testid^="picker-bot-"]').last().scrollIntoViewIfNeeded();
  await expect(group).toBeInViewport();
  await expect(space).toBeInViewport();
  await captureScreenshot(page, testInfo, "create-menu-long-roster");
  await page.setViewportSize({ width: 900, height: 360 });
  const lastBot = picker.locator('[data-testid^="picker-bot-"]').last();
  await lastBot.scrollIntoViewIfNeeded();
  await expect(lastBot).toBeInViewport({ ratio: 1 });
  await expect(group).toBeInViewport({ ratio: 1 });
  await expect(space).toBeInViewport({ ratio: 1 });
  await captureScreenshot(page, testInfo, "create-menu-short-window");
  await group.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create-group");
});
