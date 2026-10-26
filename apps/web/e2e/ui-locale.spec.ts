import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings language picker includes Hebrew and mirrors the UI right-to-left", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-he-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page);

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "עברית", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "日本語", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-he");

  await page.getByRole("option", { name: "עברית", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "כללי", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "חשבון", exact: true })).toBeVisible();
  await expect(settings.getByText("שפה", { exact: true })).toBeVisible();
  await expect(picker).toHaveText("עברית");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await captureScreenshot(page, testInfo, "ui-locale-settings-he");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeInViewport({ ratio: 1 });
  const box = await sidebar.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(page.viewportSize()?.width ?? 0, 0);
  await captureScreenshot(page, testInfo, "ui-locale-app-he");
});

test("Traditional Chinese can be selected, survives reload, and switches back to English", async ({
  page,
}, testInfo) => {
  await signup(page, `ui-locale-zh-tw-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);
  const settings = await openUserSettings(page);
  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "繁體中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "一般", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "帳號", exact: true })).toBeVisible();
  await expect(settings.getByText("語言", { exact: true })).toBeVisible();
  await expect(picker).toHaveText("繁體中文");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-tw");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.getByTestId("ui-locale-select")).toHaveText("繁體中文");
  await page.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
});
