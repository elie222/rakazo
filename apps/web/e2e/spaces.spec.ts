import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewSpace, rpc, signup } from "./helpers";

test("spaces stay invisible by default and chat creation requires approval", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByText("Personal", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
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

test("a new space auto-completes onboarding and can be deleted from its menu", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-delete-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Temporary");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();

  // Model is already connected, so onboarding skips the form and lands in Chief.
  await completeOnboarding(page);
  await expect(page).toHaveURL(/\/app\//);
  await expect(sidebar.getByText("Temporary", { exact: true })).toBeVisible();
  const temporarySpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Temporary" });
  await expect(temporarySpace.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "new-space-after-onboarding");

  // Spaces can only be deleted when empty — remove auto-created Chief first.
  await temporarySpace.getByRole("button", { name: /^Chief/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteBotDialog = page.getByRole("alertdialog", { name: /Delete Chief/ });
  await expect(deleteBotDialog).toBeVisible();
  await deleteBotDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(temporarySpace.getByRole("button", { name: /^Chief/ })).toHaveCount(0);

  // The emptied space stays selectable instead of trapping the user.
  await expect(sidebar.getByRole("button", { name: "Open Temporary" })).toBeVisible();

  // Deletion is discoverable through the visible Space actions menu.
  await sidebar.getByRole("button", { name: "Actions for Temporary" }).click();
  await captureScreenshot(page, testInfo, "space-actions-menu");
  await page.getByRole("menuitem", { name: "Delete space" }).click();
  const deleteSpaceDialog = page.getByRole("alertdialog", { name: "Delete Temporary?" });
  await expect(deleteSpaceDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "delete-space-dialog");
  await deleteSpaceDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sidebar.getByText("Temporary", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/onboarding/);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);

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
    page.locator("main").getByRole("button", { name: "Create new Bot", exact: true }),
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
