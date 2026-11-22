import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

test("quiet hours turn on at the usual hours, keep a new start, and turn off", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quiet-hours-${stamp}@rakazo.test`, "password12", "Quiet");
  await completeOnboarding(page);
  let settings = await openUserSettings(page);
  const toggle = settings.getByTestId("quiet-hours-toggle");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).not.toBeChecked();
  await expect(settings.getByTestId("quiet-hours-range")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  const start = settings.getByLabel("Quiet hours start");
  await expect(start).toHaveText("10:00 PM");
  await expect(settings.getByLabel("Quiet hours end")).toHaveText("7:00 AM");
  await chooseOption(start, "11:00 PM");
  await expect(start).toHaveText("11:00 PM");
  // Saved once the controls are back.
  await expect(start).toBeEnabled();
  await settings.getByTestId("quiet-hours-range").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-quiet-hours");

  // The server kept them, not just this page.
  await page.reload();
  settings = await openUserSettings(page);
  await expect(settings.getByLabel("Quiet hours start")).toHaveText("11:00 PM");
  await settings.getByTestId("quiet-hours-toggle").click();
  await expect(settings.getByTestId("quiet-hours-toggle")).not.toBeChecked();
  await expect(settings.getByTestId("quiet-hours-range")).toHaveCount(0);
});
