import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("an option card lets the person type an answer of their own", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=questions");
  const card = page
    .locator("[data-message-id]")
    .filter({ hasText: "What do you want me to help with?" });
  const typeAnswer = card.getByRole("button", { name: "Type your answer" });
  await expect(typeAnswer).toBeVisible();
  await captureScreenshot(page, testInfo, "ask-card-type-answer-link");
  await typeAnswer.click();
  await expect(card.getByRole("textbox", { name: "Answer" })).toBeVisible();
  await captureScreenshot(page, testInfo, "ask-card-typed-answer");
});
