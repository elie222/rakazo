import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings language picker includes Simplified Chinese and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-zh-cn-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(settings.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-zh-cn");

  await settings.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "账户", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "语言", exact: true })).toBeVisible();
  await expect(picker).toHaveText("简体中文");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-cn");
});

test("account settings language picker includes Korean and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-ko-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(settings.getByRole("option", { name: "한국어", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-ko");

  await settings.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "계정", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "언어", exact: true })).toBeVisible();
  await expect(picker).toHaveText("한국어");
  await captureScreenshot(page, testInfo, "ui-locale-settings-ko");
});

test("account settings language picker includes Spanish and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-es-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(settings.getByRole("option", { name: "Español", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-es");

  await settings.getByRole("option", { name: "Español", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Cuenta", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Idioma", exact: true })).toBeVisible();
  await expect(picker).toHaveText("Español");
  await captureScreenshot(page, testInfo, "ui-locale-settings-es");
});

test("account settings language picker includes Russian and persists it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-ru-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(settings.getByRole("option", { name: "Русский", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-ru");

  await settings.getByRole("option", { name: "Русский", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Общие", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Язык", exact: true })).toBeVisible();
  await expect(picker).toHaveText("Русский");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await captureScreenshot(page, testInfo, "ui-locale-settings-ru");
});
