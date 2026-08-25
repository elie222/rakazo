import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("board page shows in-flight columns", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `board-${stamp}@rakazo.test`, "password12", "Board User");
  await completeOnboarding(page);

  await page.goto("/app/board");
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Working", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing here").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "board-page");
});
