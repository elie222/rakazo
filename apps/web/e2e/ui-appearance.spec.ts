import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function captureSidebarSearchSelected(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const search = aside.getByTestId("sidebar-search");
  const selected = aside.getByRole("button", { name: /^Chief/ }).first();
  await expect(search).toBeVisible();
  await expect(selected).toBeVisible();
  await search.scrollIntoViewIfNeeded();

  const searchBox = await search.boundingBox();
  const selectedBox = await selected.boundingBox();
  expect(searchBox).toBeTruthy();
  expect(selectedBox).toBeTruthy();
  if (searchBox && selectedBox) {
    expect(Math.abs(searchBox.x - selectedBox.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(searchBox.x + searchBox.width - (selectedBox.x + selectedBox.width)),
    ).toBeLessThanOrEqual(1);
  }

  const box = await aside.boundingBox();
  if (box) {
    const screenshotPath = testInfo.outputPath(`${name}.png`);
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.min(box.width + 24, 360),
        height: Math.min(Math.max(box.height * 0.45, 280), 420),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

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
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-light");

  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Please review `shared/PROJECT_CHECKPOINT_WRAPUP.md`.");
  await composer.press("Enter");
  const assistantReply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "done. i handled:" });
  const inlinePath = assistantReply
    .locator("code")
    .filter({ hasText: "shared/PROJECT_CHECKPOINT_WRAPUP.md" });
  await expect(inlinePath).toBeVisible({ timeout: 30_000 });
  await expect(inlinePath).toHaveCSS("color", "rgb(26, 26, 26)");
  await captureScreenshot(page, testInfo, "inline-code-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureSidebarSearchSelected(page, testInfo, "sidebar-search-selected-dark");
});
