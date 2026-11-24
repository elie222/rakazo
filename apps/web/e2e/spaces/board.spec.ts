import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("board creates, moves, archives, and restores a ticket across its views", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  const title = "Ship the board";
  const description = "Track the kanban launch.";
  await signup(page, `board-${stamp}@rakazo.test`, "password12", "Board QA");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");
  await createNamedBot(page, "Reviewer");

  await page.getByTestId("user-menu-trigger").click();
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = await openUserSettings(page, "labs");
  const boardLab = settings.getByTestId("lab-board-toggle");
  await expect(boardLab).not.toBeChecked();
  await boardLab.click();
  await expect(boardLab).toBeChecked();
  await expect(boardLab).toBeEnabled();
  await captureScreenshot(page, testInfo, "settings-labs");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();

  const rail = page.getByTestId("app-rail");
  await expect(rail.getByRole("link", { name: "Chats" })).toHaveAttribute("aria-current", "page");
  await rail.getByRole("link", { name: "Board" }).click();
  await expect(page).toHaveURL(/\/app\/board$/);
  await expect(rail.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("board-columns")).toBeVisible();
  await expect(page.getByText("No tickets yet", { exact: true })).toBeVisible();
  const board = page.getByTestId("board-columns");
  expect(await board.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.getByRole("heading", { name: "Won't do", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await board.evaluate(
      (node) => node.parentElement!.scrollWidth > node.parentElement!.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.getByRole("combobox", { name: "Board view" })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "New ticket", exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureScreenshot(page, testInfo, "board-kanban-empty");

  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Description").fill(description);
  const owner = dialog.getByLabel("Owner");
  await owner.click();
  const planner = page.getByRole("option", { name: "Planner", exact: true });
  await expect(planner).toHaveCount(1);
  await planner.click();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(dialog).toBeHidden();
  const card = page.locator("[data-testid^='board-card-']").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Planner");
  await captureScreenshot(page, testInfo, "board-ticket-created");

  await card.click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Title")).toHaveValue(title);
  await expect(detail.getByTestId("ticket-description")).toHaveValue(description);
  await expect(detail.getByTestId("ticket-comments")).toBeVisible();
  await expect(detail.getByRole("link", { name: "Chat with Planner" })).toBeVisible();
  const save = detail.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeHidden();
  await detail.getByLabel("Description").fill("A draft");
  await detail.getByLabel("Priority").click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await expect(detail.getByLabel("Priority")).toHaveText("High");
  await detail.getByLabel("Owner").click();
  await page.getByRole("option", { name: "Reviewer", exact: true }).click();
  await expect(detail.getByRole("link", { name: "Chat with Reviewer" })).toBeVisible();
  await detail.getByLabel("Status").click();
  await page.getByRole("option", { name: "Blocked", exact: true }).click();
  await expect(detail.getByLabel("Status")).toHaveText("Blocked");
  await expect(save).toBeEnabled();
  await expect(detail.getByLabel("Description")).toHaveValue("A draft");
  await detail.getByLabel("Description").fill(description);
  await expect(save).toBeHidden();
  await captureScreenshot(page, testInfo, "board-ticket-detail");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  const blocked = board.getByRole("region", { name: "Blocked", exact: true });
  await expect(blocked.locator("[data-testid^='board-card-']")).toContainText(title);
  const done = board.getByRole("region", { name: "Done", exact: true });
  await card.dragTo(done, { targetPosition: { x: 20, y: 60 } });
  await expect(done.locator("[data-testid^='board-card-']")).toContainText(title);
  await expect(card.getByText("High", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "board-kanban");

  await page.getByRole("combobox", { name: "Board view" }).click();
  await page.getByRole("option", { name: "Table", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/board\?view=table$/);
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toContainText("Done");
  await expect(row).toContainText("Reviewer");
  await expect(row).toContainText("High");
  await captureScreenshot(page, testInfo, "board-table");

  await page.reload();
  await expect(row).toContainText("Done");
  await expect(row).toContainText("Reviewer");
  await expect(row).toContainText("High");
  await row.getByRole("button", { name: new RegExp(title) }).click();
  await expect(detail.getByLabel("Description")).toHaveValue(description);
  await page.keyboard.press("Escape");

  const filter = page.getByRole("combobox", { name: "Filter tickets" });
  const layout = page.getByRole("combobox", { name: "Board view" });
  await layout.click();
  await page.getByRole("option", { name: "Kanban", exact: true }).click();
  await filter.click();
  await page.getByRole("option", { name: "Open tickets", exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(board.getByRole("region", { name: "Won't do", exact: true })).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await captureScreenshot(page, testInfo, "board-open-tickets");

  await filter.click();
  await page.getByRole("option", { name: "All on board", exact: true }).click();
  await expect(card).toBeVisible();
  const ref = "RAK-1";
  await expect(card).toContainText(ref);
  const actions = { name: `Actions for ${ref}` };
  await done.getByRole("button", actions).click();
  await captureScreenshot(page, testInfo, "board-archive-action");
  await page.getByRole("menuitem", { name: "Archive ticket", exact: true }).click();
  await expect(card).toHaveCount(0);

  await filter.click();
  await page.getByRole("option", { name: "Archived", exact: true }).click();
  await expect(row).toContainText("Done");
  await row.getByRole("button", actions).click();
  await captureScreenshot(page, testInfo, "board-archived-tickets");
  await page.getByRole("menuitem", { name: "Restore ticket", exact: true }).click();
  await expect(row).toHaveCount(0);

  await filter.click();
  await page.getByRole("option", { name: "All on board", exact: true }).click();
  await expect(done.locator("[data-testid^='board-card-']")).toContainText(title);
  await expect(card).toContainText(ref);
});
