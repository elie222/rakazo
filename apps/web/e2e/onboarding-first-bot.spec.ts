import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("first bot continues with a prefilled name in one click", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `first-bot-${stamp}@rakazo.test`, "password12", `First bot ${stamp}`);

  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });
  await captureScreenshot(page, testInfo, "01-connect-model");
  await page.getByRole("button", { name: "Skip for now" }).click();

  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible({
    timeout: 20_000,
  });
  const name = page.locator("label:has-text('Name') input");
  await expect(name).toHaveValue("Assistant");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "02-create-first-bot");

  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await created;
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByText("Assistant").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "03-onboarding-complete");
});
