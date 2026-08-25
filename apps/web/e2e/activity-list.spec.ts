import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/** Activity rows sit above `[data-sidebar-group]` bots; match their aria-label. */
function activityRow(page: Page, botName: string) {
  return page.locator("aside").getByRole("button", {
    name: new RegExp(`^${botName}, `),
  });
}

async function captureActivitySidebar(
  page: Page,
  testInfo: Parameters<typeof captureScreenshot>[1],
  name: string,
) {
  const aside = page.locator("aside").first();
  const toggle = page.getByRole("button", { name: "Activity", exact: true });
  await toggle.scrollIntoViewIfNeeded();
  // Keep the header (bell + Create) in frame with the Now/Recent list.
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
        height: Math.min(Math.max(box.height, 420), 720),
      },
    });
    await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
    return;
  }
  await captureScreenshot(page, testInfo, name);
}

test("sidebar Now and Recent surface active and terminal runs", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `activity-${stamp}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);

  const aside = page.locator("aside").first();
  const activityToggle = page.getByRole("button", { name: "Activity", exact: true });
  await expect(activityToggle).toHaveAttribute("aria-pressed", "false");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "off");
  await expect(aside.getByText("Now", { exact: true })).toHaveCount(0);
  await expect(aside.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(aside.getByText("Loading activity…")).toHaveCount(0);
  await expect(aside.locator("[data-sidebar-group]").getByText("Chief").first()).toBeVisible();
  await captureActivitySidebar(page, testInfo, "57-activity-mode-off");

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByText("still working").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");

  // Remount ActivityList so the first poll sees the in-flight run (15s interval otherwise).
  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");
  await expect(page.getByText("still working").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Loading activity…")).toBeHidden({ timeout: 20_000 });
  await expect(aside.getByText("Now", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(activityRow(page, "Chief")).toContainText(/keep working|Running|Queued|Starting/i);
  await captureActivitySidebar(page, testInfo, "58-activity-now");

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(activityToggle).toHaveAttribute("aria-pressed", "true");
  await expect(activityToggle).toHaveAttribute("data-activity-mode", "on");
  await expect(page.getByText("Loading activity…")).toBeHidden({ timeout: 20_000 });
  await expect(aside.getByText("Recent", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toBeVisible();
  await expect(activityRow(page, "Chief")).toContainText(/Cancelled|keep working/i);
  await expect(aside.getByText("Now", { exact: true })).toHaveCount(0);
  await captureActivitySidebar(page, testInfo, "59-activity-recent");

  await page.getByPlaceholder("Search").fill("Chief");
  await expect(aside.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(activityRow(page, "Chief")).toHaveCount(0);

  await page.getByPlaceholder("Search").fill("");
  await expect(aside.getByText("Recent", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toBeVisible();
});
