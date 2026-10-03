import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, signup } from "./helpers";

test("boards kanban creates a ticket and opens it", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const title = "Ship the board";
  const description = "Track the kanban launch.";
  await signup(page, `board-${stamp}@rakazo.test`, "password12", "Board QA");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");

  await page
    .getByTestId("bots-sidebar")
    .getByRole("button", { name: "Boards", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/boards?$/);
  await expect(page.getByTestId("board-columns")).toBeVisible();
  await captureScreenshot(page, testInfo, "board-kanban");

  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New ticket" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Description").fill(description);
  const owner = dialog.getByLabel("Owner");
  await expect(owner.locator("option", { hasText: "Planner" })).toHaveCount(1);
  await owner.selectOption({ label: "Planner" });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(dialog).toBeHidden();
  const card = page.locator("[data-testid^='board-card-']").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Planner");
  await captureScreenshot(page, testInfo, "board-ticket-created");

  await card.click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Title")).toHaveValue(title);
  await expect(detail.getByTestId("ticket-description")).toContainText(description);
  await expect(detail.getByTestId("ticket-comments")).toBeVisible();
  await expect(detail.getByTestId("ticket-comments").getByText("Loading…")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "board-ticket-detail");
});
