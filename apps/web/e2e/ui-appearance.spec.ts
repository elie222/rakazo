import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("account settings appearance control switches to light mode", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-appearance-${stamp}@rakazo.test`, "password12", "Appearance QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-appearance-select");
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-appearance-control");

  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(settings.getByTestId("ui-appearance-light")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "ui-appearance-light-settings");

  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "ui-appearance-light-shell");
});
