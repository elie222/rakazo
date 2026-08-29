import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("a failed run tells the user why instead of going quiet", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `run-failure-${stamp}@rakazo.test`, "password12", "Run Failure");
  await completeOnboarding(page);

  // "fail this run" makes the scripted runtime throw, so the run fails the same way a
  // real provider error would, without depending on how models are configured.
  await page.getByPlaceholder(/^Message /).fill("fail this run");
  await page.getByRole("button", { name: "Send" }).click();

  const error = page.getByTestId("composer-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).not.toBeEmpty();

  await page.getByTestId("composer-error-dismiss").click();
  await expect(error).toBeHidden();
});
