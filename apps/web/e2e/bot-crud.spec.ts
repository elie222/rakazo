import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  expandAdvancedSection,
  openNewBot,
  rpc,
  signup,
} from "./helpers";

test("bot creation, editing, and deletion persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-crud-${stamp}@rakazo.test`, "password12", "Bot CRUD");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botList = page.locator("aside").first();
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();

  let createFailed = false;
  let resolveCreateAborted!: () => void;
  const createAborted = new Promise<void>((resolve) => {
    resolveCreateAborted = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createFailed = true;
    await route.abort("failed");
    resolveCreateAborted();
  });
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill("New Bot");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await createAborted;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("create-bot-error")).toBeVisible();
  expect(createFailed).toBe(true);
  await page.unroute("**/rpc/bots/create");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  let failedPostCreateRefresh = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (failedPostCreateRefresh) {
      await route.fallback();
      return;
    }
    failedPostCreateRefresh = true;
    await route.abort("failed");
  });
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect.poll(() => failedPostCreateRefresh).toBe(true);
  await page.unroute("**/rpc/spaces/list");
  await expect(botList.getByRole("button", { name: /^New Bot/ })).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  const deletedBotPath = new URL(page.url()).pathname;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe(deletedBotPath);
  await captureScreenshot(page, testInfo, "27-created-bot");

  await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toBeVisible();
  async function editName(value: string) {
    await page.getByRole("button", { name: "Edit name", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Name", exact: true });
    await input.fill(value);
    await input.press("Enter");
  }
  const descriptionInput = page.getByRole("textbox", {
    name: "How other bots see it",
    exact: true,
  });
  await editName("Researcher");
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await descriptionInput.fill("Finds reliable sources and turns them into concise briefs.");
  await page.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await studio.getByRole("button", { name: "Color #EAB308" }).click();
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await expect(studio).toBeHidden();
  await expect(botList.getByRole("button", { name: /^Researcher/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();

  await page.locator("main").getByRole("button", { name: "Researcher", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toHaveText(
    "Researcher",
  );
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await expect(descriptionInput).toHaveValue(
    "Finds reliable sources and turns them into concise briefs.",
  );
  const settings = page.getByTestId("bot-settings");
  await settings.getByTestId("avatar-studio-trigger").click();
  await expect(studio).toBeVisible();
  await expect(studio.getByRole("button", { name: "Color #EAB308" })).toHaveClass(/ring-2/);
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const modelSelect = settings.getByRole("combobox", { name: "Model", exact: true });
  const teamComputer = settings.getByRole("button", { name: "Team" });
  const openWork = settings.getByTestId("bot-scratchpad");
  await expect(teamComputer).toBeHidden();
  await expect(settings.getByRole("switch", { name: "Read replies aloud" })).toBeHidden();
  await expect(settings.getByRole("switch", { name: "Manage the bots it creates" })).toBeHidden();
  await expect(modelSelect).toHaveCount(0);
  await expect(openWork).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
  const notificationsHeading = settings.getByRole("heading", {
    name: "Notifications",
    exact: true,
  });
  await expect(notificationsHeading).toBeVisible();
  const advancedTrigger = settings.getByRole("button", { name: "Advanced", exact: true });
  for (const property of ["font-size", "font-weight", "color"]) {
    const expected = await advancedTrigger.evaluate(
      (node, prop) => getComputedStyle(node).getPropertyValue(prop),
      property,
    );
    await expect(notificationsHeading).toHaveCSS(property, expected);
  }
  await expect(settings.getByRole("button", { name: "Advanced", exact: true })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(
    settings.getByRole("switch", { name: "When it finishes or needs input", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-settings-sections-collapsed");
  const advancedSection = settings.getByTestId("bot-settings-advanced");
  await expandAdvancedSection(advancedSection);
  await expect(settings.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  await expect(settings.locator('label[for$="-model"]')).toHaveClass("sr-only");
  await expect(modelSelect).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-settings-sections-advanced");
  await rpc(page, "scratchpad/create", {
    botId: deletedBotPath.split("/").at(-1),
    title: "First fixture task",
  });
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.locator("main").getByRole("button", { name: "Researcher", exact: true }).click();
  await expandAdvancedSection(advancedSection);
  await expect(openWork.getByText("First fixture task", { exact: true })).toBeVisible();
  await openWork.getByRole("button", { name: "Add open work" }).click();
  await openWork.getByRole("textbox", { name: "New open-work item" }).fill("Second fixture task");
  await openWork.getByRole("button", { name: "Add", exact: true }).click();
  const workRows = openWork.locator(".group");
  await expect(workRows).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await workRows.first().hover();
    await workRows.first().getByRole("button", { name: "Remove" }).click();
  }
  await expect(openWork).toHaveCount(0);
  const disabledTools = settings.getByLabel("Disable a tool");
  await expect(disabledTools).toBeVisible();
  await disabledTools.selectOption("web_search");
  await expect(settings.getByRole("button", { name: "Enable Web search" })).toBeVisible();
  await captureScreenshot(page, testInfo, "27c-disabled-builtin-tools");
  await expect(teamComputer).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Read replies aloud" })).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Manage the bots it creates" })).toBeVisible();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect).toContainText("Space default");
  await captureScreenshot(page, testInfo, "27a-bot-settings-model");
  await page.getByRole("button", { name: "Show computer" }).click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(page.getByRole("button", { name: "Show settings" })).toBeVisible();
  // Overlay may flash during boot or never appear (already ready/asleep/stopped). Assert panel
  // chrome, then wait until any overlay has cleared — avoid Locator.or() strict-mode multi-hits.
  const bootOverlay = page.getByText(/Booting up .* computer/);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await expect(bootOverlay).toBeHidden();
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-more-button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27b-computer-panel");
  await page.getByRole("button", { name: "Show settings" }).click();

  await editName("Atlas");
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await descriptionInput.fill("Builds durable, source-backed research briefs.");
  await descriptionInput.blur();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await captureScreenshot(page, testInfo, "28-edited-bot-profile");

  await page.reload();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await page.locator("main").getByRole("button", { name: "Atlas", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit name", exact: true })).toHaveText("Atlas");
  await expandAdvancedSection(page.getByTestId("bot-settings-advanced"));
  await expect(descriptionInput).toHaveValue("Builds durable, source-backed research briefs.");
  await captureScreenshot(page, testInfo, "29-reloaded-bot-profile");

  // Wrap in the narrow dialog without pushing Delete below the Playwright viewport.
  const longUnbrokenName = "A".repeat(48);
  expect(longUnbrokenName.length).toBe(48);
  await editName(longUnbrokenName);
  const longNameBot = botList.getByRole("button", {
    name: new RegExp(`^${longUnbrokenName}`),
  });
  await expect(longNameBot).toBeVisible();
  await expect(page.getByPlaceholder(`Message ${longUnbrokenName}`)).toBeVisible();

  await longNameBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: `Delete ${longUnbrokenName}?`,
  });
  await expect(deleteDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "30-delete-bot-confirmation");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.waitForURL((url) => url.pathname !== deletedBotPath);

  await page.goto(deletedBotPath);
  await page.waitForURL((url) => url.pathname !== deletedBotPath);
  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "31-deleted-bot-fallback");
});
