import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("routine run-now completes and survives reload", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `routine-${stamp}@rakazo.test`, "password12", "Routine");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(0);
  await page.getByText("+ New routine").click();
  await page.locator("label:has-text('Name') input").fill("Daily verification");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write routine-run-now-ok into the durable task result");
  await page.getByLabel("How often").selectOption("Weekdays");
  await expect(page.getByText("Weekdays", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("at 9:00 AM", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "32-routine-configured");

  await page.getByRole("button", { name: "Save" }).click();
  const routine = page.getByRole("button", { name: /Daily verification/ });
  await expect(routine).toContainText("Weekdays at 9:00 AM");
  await captureScreenshot(page, testInfo, "33-routine-scheduled");

  await routine.click();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await page.getByTitle("Agent computer").click();
  await expect(page.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});
