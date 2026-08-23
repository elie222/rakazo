import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

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
