import { expect, test } from "@playwright/test";

test("a routine approval explains the change and lets people compare instructions", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=approvals&theme=light");
  const card = page.getByTestId("routine-approval-card");
  await expect(card.getByText("Every Monday at 11:00 AM", { exact: true })).toBeVisible();
  await expect(card.getByText("Previously: Every Monday at 10:00 AM")).toBeVisible();
  await expect(
    card.getByText("Skip cheddar when it is out of stock", { exact: false }),
  ).toBeVisible();
  await expect(card.getByText("Order the usual groceries", { exact: true })).toBeHidden();

  const path = testInfo.outputPath("routine-update-review.png");
  await card.screenshot({ path, animations: "disabled", caret: "hide" });
  await testInfo.attach("routine-update-review", { contentType: "image/png", path });

  await card.getByRole("button", { name: "Previous instructions" }).click();
  await expect(card.getByText("Order the usual groceries", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "More approval options" }).click();
  await expect(page.getByRole("menuitem", { name: "Always allow routine updates" })).toBeVisible();
});
