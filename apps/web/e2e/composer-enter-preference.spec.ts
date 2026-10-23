import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test.describe("touch composer", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("Settings controls Enter behavior and persists the preference", async ({
    page,
  }, testInfo) => {
    await signup(page, `enter-pref-true-${Date.now()}@rakazo.test`, "password12", "Composer QA");
    await completeOnboarding(page);
    const composer = page.getByRole("combobox", { name: /^Message/ });
    await expect(page.getByTestId("composer-enter-to-send-toggle")).toBeHidden();
    await composer.fill("default behavior");
    await composer.press("End");
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue("default behavior\n");
    await composer.press("Enter");
    await expect(composer).toHaveValue("default behavior\n\n");
    await composer.press("Control+Enter");
    await expect(composer).toHaveValue("");
    await composer.fill("saved draft");
    await page.getByTestId("user-menu-trigger").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("user-settings");
    await settings.getByTestId("advanced-settings").locator("button[aria-expanded]").click();
    const preference = settings.getByRole("switch", { name: "Send with Enter", exact: true });
    await expect(preference).toBeChecked({ checked: false });
    await preference.click();
    await expect(preference).toBeChecked({ checked: true });
    await settings
      .getByTestId("advanced-settings")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await captureScreenshot(page, testInfo, "composer-enter-preference-touch");
    await settings.getByRole("button", { name: "Close user settings" }).click();
    await expect(composer).toHaveValue("saved draft");
    await page.reload();
    await expect(composer).toHaveValue("saved draft");
    await composer.press("End");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
  });
});
