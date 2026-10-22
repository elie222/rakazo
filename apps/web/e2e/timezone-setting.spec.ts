import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test.use({ timezoneId: "Pacific/Auckland" });

test("account settings save avatar style and timezone, and offer this device's zone back", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `timezone-${stamp}@rakazo.test`, "password12", "Timezone QA");
  await completeOnboarding(page);

  const settings = await openUserSettings(page);

  // Avatar style previews differ for robot and organic.
  await expect(settings.getByRole("heading", { name: "Avatars", exact: true })).toBeVisible();
  const robot = settings.getByTestId("avatar-style-robot");
  const organic = settings.getByTestId("avatar-style-organic");
  await expect(robot).toBeVisible();
  await expect(organic).toBeVisible();
  await expect(organic).toHaveAttribute("aria-pressed", "true");
  await expect(robot).toHaveAttribute("aria-pressed", "false");
  await expect(robot.locator(".rakazo-bot-avatar")).toBeVisible();
  await expect(organic.locator(".rakazo-organic-avatar")).toBeVisible();
  await expect(robot.locator(".rakazo-organic-avatar")).toHaveCount(0);
  await expect(organic.locator(".rakazo-bot-avatar")).toHaveCount(0);

  const robotMarkup = await robot
    .locator("svg")
    .first()
    .evaluate((el) => el.outerHTML);
  const organicMarkup = await organic
    .locator("svg")
    .first()
    .evaluate((el) => el.outerHTML);
  expect(robotMarkup).not.toBe(organicMarkup);

  await organic.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "account-avatars-style-previews");

  await robot.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");

  await expect(settings.getByRole("heading", { name: "Timezone", exact: true })).toBeVisible();
  const select = settings.getByRole("combobox", { name: "Timezone" });
  // First sign-in saves the browser's zone without asking.
  await expect(select).toHaveValue("Pacific/Auckland");
  await expect(settings.getByTestId("timezone-use-device")).toHaveCount(0);

  await select.selectOption("Europe/London");
  const useDevice = settings.getByRole("button", { name: "Use Pacific/Auckland" });
  await expect(useDevice).toBeVisible();
  await useDevice.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "account-timezone-setting");

  // Saved choices survive a reload; the browser zone does not overwrite the timezone.
  await page.reload();
  const reopened = await openUserSettings(page);
  await expect(reopened.getByTestId("avatar-style-robot")).toHaveAttribute("aria-pressed", "true");
  await expect(reopened.getByRole("combobox", { name: "Timezone" })).toHaveValue("Europe/London");

  await reopened.getByRole("button", { name: "Use Pacific/Auckland" }).click();
  await expect(reopened.getByRole("combobox", { name: "Timezone" })).toHaveValue(
    "Pacific/Auckland",
  );
  await expect(reopened.getByTestId("timezone-use-device")).toHaveCount(0);
});
