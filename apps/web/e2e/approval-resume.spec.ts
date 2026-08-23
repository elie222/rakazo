import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.describe.configure({ mode: "serial" });

test("approval input resumes durable work", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `approval-${stamp}@rakazo.test`, "password12", "Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");

  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Reply with one city name.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send it" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit first" })).toBeVisible();
  await captureScreenshot(page, testInfo, "20-approval-input-request");

  await page.getByRole("button", { name: "Edit first" }).click();
  const answer = page.getByRole("textbox", { name: "Answer" });
  await answer.fill("ask me which city to use again");
  await expect(page.getByRole("button", { name: "Send answer" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "21-approval-custom-answer");
  await page.getByRole("button", { name: "Send answer" }).click();

  await expect(prompt).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByText("Answered: ask me which city to use again", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send it" })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "22-second-approval-prompt");

  await page.getByRole("button", { name: "Edit first" }).click();
  await answer.fill("Paris");
  await captureScreenshot(page, testInfo, "23-second-approval-answer");
  await page.getByRole("button", { name: "Send answer" }).click();

  const resumed = page.getByText(
    "on it. i will work this in the background and come back with a result.",
    { exact: true },
  );
  await expect(resumed).toBeVisible({ timeout: 30_000 });
  const handledAnswer = page.getByText("done. i handled: Paris", { exact: true });
  await expect(handledAnswer).toBeVisible();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible();

  await page.reload();
  await expect(resumed).toBeVisible({ timeout: 20_000 });
  await expect(handledAnswer).toBeVisible();
  await expect(page.getByText("Answered: Paris", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "24-approval-resumed-after-reload");

  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("No longer active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send it" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "25-stopped-approval-prompt");
});
