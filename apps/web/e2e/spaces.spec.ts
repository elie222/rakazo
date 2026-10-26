import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

test("the only space is named in the sidebar and chat creation requires approval", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await sidebar.getByRole("button", { name: "Actions for Personal" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete space" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const onlySpaceSettings = page.getByTestId("user-settings");
  await expect(onlySpaceSettings).toHaveAttribute("data-settings-section", "space");
  await expect(onlySpaceSettings.getByLabel("Name")).toHaveValue("Personal");
  // The default space is never deletable, so the action is absent.
  await expect(onlySpaceSettings.getByRole("button", { name: "Delete space" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "space-settings-only-space");
  // A lone space is the whole app, so General lists no spaces.
  await onlySpaceSettings.getByRole("button", { name: "Back" }).click();
  await expect(onlySpaceSettings.getByTestId("settings-spaces")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(onlySpaceSettings).toHaveCount(0);
  await captureScreenshot(page, testInfo, "single-space-sidebar");

  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await dialog.getByLabel("Name").fill("Customer support");
  await captureScreenshot(page, testInfo, "new-space-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Create a space named Customer support");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Create space", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await expect(sidebar.getByText("Customer support", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-space-chat-approval");
  await page.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  await expect(sidebar.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  const supportSpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Customer support" });
  const supportSpaceGroup = await supportSpace.getAttribute("data-sidebar-group");
  const supportSpaceId = supportSpaceGroup?.split(":")[1];
  expect(supportSpaceId).toBeTruthy();
  await supportSpace.getByRole("button", { name: "Open Customer support" }).click();
  await page.waitForURL(/\/(onboarding|app)/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(supportSpaceId);
  await completeOnboarding(page);

  await expect(sidebar.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "spaces-sidebar");

  const personalSpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Personal" });
  const personalSpaceGroup = await personalSpace.getAttribute("data-sidebar-group");
  const personalSpaceId = personalSpaceGroup?.split(":")[1];
  expect(personalSpaceId).toBeTruthy();
  await personalSpace.getByRole("button", { name: /^Chief/ }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(personalSpaceId);
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible();
});

test("a new space auto-completes onboarding, is renamed in its settings, and is deleted with its bots", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-delete-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Typo space");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();

  // Model is already connected, so onboarding skips the form and lands in Chief.
  await completeOnboarding(page);
  await expect(page).toHaveURL(/\/app\//);
  await expect(sidebar.getByText("Typo space", { exact: true })).toBeVisible();
  const occupied = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Typo space" });
  await expect(occupied.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "new-space-after-onboarding");

  // The space menu's Settings opens the Space section, where it is renamed in place.
  await sidebar.getByRole("button", { name: "Actions for Typo space" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename space" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "space");
  const spaceName = settings.getByTestId("space-settings").getByLabel("Name");
  await expect(spaceName).toHaveValue("Typo space");
  await spaceName.fill("Temporary");
  await captureScreenshot(page, testInfo, "space-settings-rename");
  await spaceName.press("Enter");
  await expect(settings.getByRole("heading", { name: "Temporary" })).toBeVisible();
  await expect(sidebar.getByText("Temporary", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Typo space", { exact: true })).toHaveCount(0);

  // An occupied space is deleted with its bots after one confirmation naming them.
  await settings.getByRole("button", { name: "Delete space" }).click();
  const deleteSpaceDialog = page.getByRole("alertdialog", {
    name: "Delete Temporary and its 1 bot?",
  });
  await expect(deleteSpaceDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "delete-space-dialog");
  await deleteSpaceDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await page.reload();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);

  // A stale onboarding URL recovers without duplicating the bot.
  await page.goto("/onboarding");
  await page.waitForURL(/\/app/);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
});

test("deleting the last bot in a space stays in the app after first use", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `spaces-empty-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);
  const [chief] = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  expect(chief).toBeTruthy();
  await rpc(page, "bots/archive", { botId: chief!.id });
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Side");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await page.waitForURL(/\/(onboarding|app)/);
  await completeOnboarding(page);
  await expect(sidebar.getByText("Side", { exact: true })).toBeVisible();

  // Delete the only bot in the new space: the app must stay put instead of
  // forcing onboarding again.
  const sideBot = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Side" })
    .getByRole("button", { name: /^Chief/ });
  await sideBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: /Delete Chief/ });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sideBot).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await page.reload();
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: "Open Side" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("button", { name: "New bot", exact: true }),
  ).toBeVisible();

  await sidebar.getByRole("button", { name: "Actions for Side" }).click();
  await page.getByRole("menuitem", { name: "Delete space" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete Side?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(sidebar.getByText("Side", { exact: true })).toHaveCount(0);
  await sidebar.getByRole("button", { name: /^Archived/ }).click();
  await expect(sidebar.getByText("Chief", { exact: true })).toBeVisible();
});

test("a space's menu opens its settings in place, and General lists every space", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-settings-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Support");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await completeOnboarding(page);
  await expect(sidebar.getByText("Support", { exact: true })).toBeVisible();
  const chatPath = new URL(page.url()).pathname;
  // Settings stay on the chat's route; only the overlay params change.
  const onChat = () => {
    const url = new URL(page.url());
    expect(url.pathname).toBe(chatPath);
    expect(url.searchParams.get("settings")).toBe("space");
  };
  const selected = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
  await page.evaluate(() => {
    document.documentElement.dataset.settingsTest = "same-document";
  });

  // Support is selected; Personal's menu opens Personal's settings without leaving Support.
  await sidebar.getByRole("button", { name: "Actions for Personal" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "space");
  await expect(settings.getByRole("heading", { name: "Personal" })).toBeVisible();
  onChat();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selected);
  await expect(page.locator("html")).toHaveAttribute("data-settings-test", "same-document");
  await captureScreenshot(page, testInfo, "space-settings-from-menu");

  // Back leads to General, whose Spaces list opens any space's page.
  await settings.getByRole("button", { name: "Back" }).click();
  await expect(settings).toHaveAttribute("data-settings-section", "general");
  const spaceList = settings.getByTestId("settings-spaces");
  await expect(spaceList.getByText("Personal", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-general-spaces");
  await spaceList.getByRole("button", { name: "Manage Support" }).click();
  await expect(settings.getByRole("heading", { name: "Support" })).toBeVisible();
  await expect(settings).toHaveAttribute("data-settings-section", "space");
  onChat();
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selected);
  await expect(page.locator("html")).toHaveAttribute("data-settings-test", "same-document");

  // Models, voice, and approvals follow the account until this space customizes them.
  const overrides = settings.getByTestId("space-setting-overrides");
  for (const name of ["Models", "Voice", "Approvals"]) {
    await expect(overrides.getByRole("button", { name: `Customize ${name}` })).toBeVisible();
  }
  await expect(overrides.getByText("Your defaults", { exact: true })).toHaveCount(3);
  await captureScreenshot(page, testInfo, "space-settings-uses-defaults");

  await overrides.getByRole("button", { name: "Customize Approvals" }).click();
  const approvals = overrides.getByTestId("space-setting-confirmations");
  const spaceNeverAsk = approvals.getByRole("button", { name: "Never ask", exact: true });
  await expect(spaceNeverAsk).toHaveAttribute("aria-pressed", "false");
  await spaceNeverAsk.click();
  await expect(spaceNeverAsk).toHaveAttribute("aria-pressed", "true");
  await expect(overrides.getByText("Your defaults", { exact: true })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "space-settings-customized-confirmations");

  // The account's own approvals stay as they were.
  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByRole("button", { name: "Never ask", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await settings.getByTestId("settings-nav-general").click();
  await spaceList.getByRole("button", { name: "Manage Support" }).click();
  await expect(settings.getByRole("heading", { name: "Support" })).toBeVisible();
  await overrides.getByRole("button", { name: "Use defaults for Approvals" }).click();
  await expect(approvals.getByTestId("approval-mode")).toHaveCount(0);
  await expect(overrides.getByRole("button", { name: "Customize Approvals" })).toBeVisible();
});
