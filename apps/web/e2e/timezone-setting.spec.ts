import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test.use({ timezoneId: "Pacific/Auckland" });

test("account settings save the timezone and offer this device's zone back", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `timezone-${stamp}@rakazo.test`, "password12", "Timezone QA");
  await completeOnboarding(page);

  const settings = await openUserSettings(page);

  const select = settings.getByRole("combobox", { name: "Timezone" });
  // First sign-in saves the browser's zone without asking.
  await expect(select).toHaveValue("Pacific/Auckland");
  await expect(settings.getByTestId("timezone-use-device")).toHaveCount(0);

  await select.selectOption("Europe/London");
  const useDevice = settings.getByRole("button", { name: "Use Pacific/Auckland" });
  await expect(useDevice).toBeVisible();
  await useDevice.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "account-timezone-setting");

  // Saved choices survive a reload, which keeps settings open; the browser zone does not overwrite the timezone.
  await page.reload();
  const reopened = page.getByTestId("user-settings");
  await expect(reopened.getByRole("combobox", { name: "Timezone" })).toHaveValue("Europe/London");

  await reopened.getByRole("button", { name: "Use Pacific/Auckland" }).click();
  await expect(reopened.getByRole("combobox", { name: "Timezone" })).toHaveValue(
    "Pacific/Auckland",
  );
  await expect(reopened.getByTestId("timezone-use-device")).toHaveCount(0);
});
