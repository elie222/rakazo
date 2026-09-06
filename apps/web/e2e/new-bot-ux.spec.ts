import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  openNewBot,
  signup,
} from "./helpers";

test("create opens empty chat, picker lists bots, and sidebar collapses", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `new-bot-ux-${stamp}@rakazo.test`, "password12", "New Bot UX");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("create-menu-trigger").click();
  const picker = page.getByTestId("bot-create-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("create-new-bot")).toBeVisible();
  await expect(picker.getByText("Chief", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "plus-picker-bots");
  await page.keyboard.press("Escape");

  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-chat-sidepanel-closed");

  await page.getByTestId("minimize-bots-sidebar").click();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "true");
  const edge = page.getByTestId("bots-sidebar-edge");
  await expect(edge).toBeVisible();
  await captureScreenshot(page, testInfo, "bots-sidebar-collapsed");

  const box = await edge.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 80, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("bots-sidebar")).toHaveAttribute("data-collapsed", "false");
  await captureScreenshot(page, testInfo, "bots-sidebar-expanded");
});

test("later bot waits before showing the focus card; sending cancels it", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `focus-delay-${stamp}@rakazo.test`, "password12", "Focus Delay");
  await completeOnboarding(page);
  // First bot from onboarding shows the focus card immediately.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();

  await page.clock.install();
  await openNewBot(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);

  await page.clock.fastForward(9_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(1_500);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible();

  await openNewBot(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("I'll set this up myself");
  await page.keyboard.press("Enter");
  await page.clock.fastForward(12_000);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toHaveCount(0);
});
