import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("teach a task records interaction and saves a draft", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `teach-${stamp}@rakazo.test`, "password12", "Teach");
  await completeOnboarding(page);
  await page.getByTitle("Agent computer").click();
  await page.getByTestId("teach-start-button").click();
  await page.getByTestId("teach-goal-input").fill("Export weekly CRM list");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByTestId("teach-recording-overlay")).toBeVisible();
  await expect(page.getByTestId("teach-capture-overlay")).toBeVisible();
  await page.getByTestId("teach-capture-overlay").click({ position: { x: 200, y: 200 } });
  await page.keyboard.type("demo");
  await page.getByTestId("teach-stop-overlay").click();
  await expect(page.getByTestId("skill-draft-card")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("skill-draft-card").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByTestId("skill-draft-card").getByRole("button", { name: "Saved" }),
  ).toBeVisible({ timeout: 10_000 });
});
