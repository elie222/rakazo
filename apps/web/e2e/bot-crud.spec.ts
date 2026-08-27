import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewBot, signup } from "./helpers";

test("bot creation, editing, and deletion persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-crud-${stamp}@rakazo.test`, "password12", "Bot CRUD");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botList = page.locator("aside").first();
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();

  await openNewBot(page);
  await expect(page.getByText("New bot", { exact: true })).toBeVisible();
  await page.locator("label:has-text('Name') input").fill("Researcher");
  const longTitle = `Market researcher ${"and source verifier ".repeat(9)}`;
  const normalizedLongTitle = longTitle.trim();
  expect(longTitle.length).toBeGreaterThan(160);
  await page.locator("label:has-text('Title') input").fill(longTitle);
  await page
    .locator("label:has-text('Description') textarea")
    .fill("Finds reliable sources and turns them into concise briefs.");
  await captureScreenshot(page, testInfo, "26-new-bot-form");
  await page.route("**/rpc/bots/create", async (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("create-bot-error")).toHaveText("Failed to fetch");
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "26a-new-bot-error");
  await page.unroute("**/rpc/bots/create");
  let failedPostCreateRefresh = false;
  await page.route("**/rpc/botSections/list", async (route) => {
    if (failedPostCreateRefresh) {
      await route.fallback();
      return;
    }
    failedPostCreateRefresh = true;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(botList.getByRole("button", { name: /^Researcher/ })).toBeVisible();
  expect(failedPostCreateRefresh).toBe(true);
  await page.unroute("**/rpc/botSections/list");
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  const deletedBotPath = new URL(page.url()).pathname;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe(deletedBotPath);
  await captureScreenshot(page, testInfo, "27-created-bot");

  await page.locator("main").getByRole("button", { name: "Researcher", exact: true }).click();
  await expect(page.getByText("Settings", { exact: true })).toBeVisible();
  const nameInput = page.locator("label:has-text('Name') input");
  const titleInput = page.locator("label:has-text('Title') input");
  const descriptionInput = page.locator("label:has-text('Description') textarea");
  await expect(nameInput).toHaveValue("Researcher");
  await expect(titleInput).toHaveValue(normalizedLongTitle);
  await expect(descriptionInput).toHaveValue(
    "Finds reliable sources and turns them into concise briefs.",
  );
  const settings = page.getByTestId("bot-settings");
  const modelSelect = settings.locator("label:has-text('Model') select");
  const teamComputer = settings.getByRole("button", { name: "Team" });
  const openWork = settings.getByTestId("bot-scratchpad");
  await expect(teamComputer).toBeHidden();
  await expect(modelSelect).toBeHidden();
  await expect(openWork).toBeHidden();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "27a-settings-panel");
  await settings.getByText("Advanced", { exact: true }).click();
  await expect(teamComputer).toBeVisible();
  await expect(openWork).toBeVisible();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toContainText("Workspace default");
  await captureScreenshot(page, testInfo, "27a-bot-settings-model");
  await page.getByRole("button", { name: "Show computer" }).click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(page.getByRole("button", { name: "Show settings" })).toBeVisible();
  // Overlay may flash during boot or never appear (already ready/asleep/stopped). Assert panel
  // chrome, then wait until any overlay has cleared — avoid Locator.or() strict-mode multi-hits.
  const bootOverlay = page.getByText(/Booting up .* computer/);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toBeVisible();
  await expect(bootOverlay).toBeHidden();
  await captureScreenshot(page, testInfo, "27b-computer-panel");
  await page.getByRole("button", { name: "Show settings" }).click();

  await nameInput.fill("Atlas");
  await titleInput.fill("Research lead");
  await descriptionInput.fill("Builds durable, source-backed research briefs.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await captureScreenshot(page, testInfo, "28-edited-bot-profile");

  await page.reload();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await page.locator("main").getByRole("button", { name: "Atlas", exact: true }).click();
  await expect(nameInput).toHaveValue("Atlas");
  await expect(titleInput).toHaveValue("Research lead");
  await expect(descriptionInput).toHaveValue("Builds durable, source-backed research briefs.");
  await captureScreenshot(page, testInfo, "29-reloaded-bot-profile");

  const atlas = botList.getByRole("button", { name: /^Atlas/ });
  await atlas.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Atlas?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "30-delete-bot-confirmation");
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(botList.getByText("Atlas", { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.waitForURL((url) => url.pathname !== deletedBotPath);

  await page.goto(deletedBotPath);
  await page.waitForURL((url) => url.pathname !== deletedBotPath);
  await expect(botList.getByText("Atlas", { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "31-deleted-bot-fallback");
});
