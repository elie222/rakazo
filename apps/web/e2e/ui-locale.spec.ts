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
  await expect(settings.getByRole("heading", { name: "שפה", exact: true })).toBeVisible();
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
