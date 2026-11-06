import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const PASSWORD = "password12";

/** The account's saved zone, straight from the server. */
async function meTimezone(page: Page): Promise<string | null> {
  const me = await rpc<{ timezone: string | null }>(page, "me", null);
  return me.timezone;
}

// One account under two device zones: created under Europe/London, signed back into under
// Pacific/Auckland. The visits build on each other, so the file runs in order on one worker.
test.describe.configure({ mode: "serial" });

const stamp = Date.now();
const followEmail = `timezone-follow-${stamp}@rakazo.test`;

test.describe("device zone Europe/London", () => {
  test.use({ timezoneId: "Europe/London" });

  test("the shell reports this device's zone and the account takes it", async ({ page }) => {
    await signup(page, followEmail, PASSWORD, "Timezone Follow");
    await completeOnboarding(page);

    await expect.poll(() => meTimezone(page)).toBe("Europe/London");
  });
});

test.describe("device zone Pacific/Auckland", () => {
  test.use({ timezoneId: "Pacific/Auckland" });

  test("a zone taken from the device follows the device on the next visit", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByPlaceholder("Your email address").fill(followEmail);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/app\//);

    // The shell reported the new device zone; a reload confirms what the account kept.
    await page.reload();
    await expect.poll(() => meTimezone(page)).toBe("Pacific/Auckland");
    const settings = await openUserSettings(page);
    await expect(settings.getByTestId("timezone-select")).toHaveValue("Pacific/Auckland");
    // The saved zone is the device's, so the switch-back button has nothing to offer.
    await expect(settings.getByTestId("timezone-use-device")).toHaveCount(0);
  });

  test("a zone picked by hand stays, and the button returns the account to the device", async ({
    page,
  }) => {
    await signup(page, `timezone-pick-${stamp}@rakazo.test`, PASSWORD, "Timezone Pick");
    await completeOnboarding(page);
    await expect.poll(() => meTimezone(page)).toBe("Pacific/Auckland");

    // A hand-picked zone: the device keeps reporting its own, and the server keeps the choice.
    const settings = await openUserSettings(page);
    await settings.getByTestId("timezone-select").selectOption("Europe/London");
    await expect(settings.getByTestId("timezone-select")).toHaveValue("Europe/London");

    await page.reload();
    await expect.poll(() => meTimezone(page)).toBe("Europe/London");
    const reopened = await openUserSettings(page);
    await expect(reopened.getByTestId("timezone-select")).toHaveValue("Europe/London");

    // "Use {zone}" switches the account back to following this device.
    await reopened.getByTestId("timezone-use-device").click();
    await expect(reopened.getByTestId("timezone-select")).toHaveValue("Pacific/Auckland");
    await expect.poll(() => meTimezone(page)).toBe("Pacific/Auckland");
  });
});
