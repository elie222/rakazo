import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("pinned bots and sidebar sections persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-organize-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Chief");
  await captureScreenshot(page, testInfo, "pinned-bots");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toHaveCount(0);

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await captureScreenshot(page, testInfo, "move-to-section-menu");
  await page
    .getByRole("menu", { name: /Move Chief to section/ })
    .getByText("New section")
    .click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Projects");
  await dialog.getByRole("button", { name: "Create" }).click();

  const projects = sidebar.locator('[data-sidebar-group^="section:"]');
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");
  await captureScreenshot(page, testInfo, "bot-sections");

  await page.reload();
  await expect(projects).toContainText("Projects");
  await expect(projects).toContainText("Chief");

  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await page
    .getByRole("menu", { name: /Move Chief to section/ })
    .getByRole("menuitem", { name: "Unassigned", exact: true })
    .click();
  await expect(sidebar.locator('[data-sidebar-group="unassigned"]')).toContainText("Chief");
});

test("group chats share every context-menu action", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-organize-${stamp}@rakazo.test`, "password12", "Group Menu");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const partner = await rpc<{ id: string }>(page, "bots/create", {
    name: "Partner",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "groups/create", {
    name: "Group menu",
    botIds: [chiefId, partner.id],
  });
  await page.reload();

  const sidebar = page.locator("aside").first();
  const group = sidebar.getByRole("button", { name: /^Group menu/ });
  await group.click({ button: "right" });
  for (const action of [
    "Pin",
    "Move to",
    "Mark as Unread",
    "Edit Profile",
    "Duplicate",
    "Clear conversation",
    "Archive",
    "Delete",
  ]) {
    await expect(page.getByRole("menuitem", { name: action, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "group-context-menu-desktop");

  await page.getByRole("menuitem", { name: "Mark as Unread", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as Read", exact: true }).click();

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-group="pinned"]')).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await page
    .getByRole("menu", { name: /Move Group menu to section/ })
    .getByRole("menuitem", { name: "New section", exact: true })
    .click();
  const sectionDialog = page.getByRole("dialog", { name: "New section" });
  await sectionDialog.getByLabel("Name").fill("Teams");
  await sectionDialog.getByRole("button", { name: "Create" }).click();
  await expect(sidebar.locator('[data-sidebar-group^="section:"]')).toContainText("Group menu");

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Clear conversation", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Clear Group menu’s conversation?" }),
  ).toHaveCount(0);

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  const copy = sidebar.getByRole("button", { name: /^Group menu copy/ });
  await expect(copy).toBeVisible();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Group menu copy?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: /^Group menu copy/ })).toHaveCount(0);
  await expect(sidebar.getByText("Archived", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await group.click({ button: "right" });
  await captureScreenshot(page, testInfo, "group-context-menu-mobile");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });

  await group.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Profile", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "group-settings");
});
