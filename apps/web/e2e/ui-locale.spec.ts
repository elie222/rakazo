import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("account settings language picker includes Simplified Chinese and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-zh-cn-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(settings.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-zh-cn");

  await settings.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "语言", exact: true })).toBeVisible();
  await expect(picker).toHaveText("简体中文");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-cn");
});
