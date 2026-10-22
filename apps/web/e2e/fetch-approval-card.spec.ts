import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("asks before fetching a site the message did not name", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `fetch-approval-${stamp}@rakazo.test`, "password12", "Fetch Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a fetch approval card");
  await page.keyboard.press("Enter");

  const always = page.getByRole("button", { name: "Always allow example.test", exact: true });
  await expect(always).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("url: https://docs.example.test/page?q=fixture")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "fetch-approval-card");

  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByTestId("transcript").getByText("Denied", { exact: true })).toBeVisible();
});
