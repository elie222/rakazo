import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const touch of [false, true]) {
  test.describe(touch ? "touch composer" : "desktop composer", () => {
    test.use({ hasTouch: touch, isMobile: touch });

    test("Settings controls Enter behavior and persists the preference", async ({
      page,
    }, testInfo) => {
      await signup(
        page,
        `enter-pref-${touch}-${Date.now()}@rakazo.test`,
        "password12",
        "Composer QA",
      );
      await completeOnboarding(page);
      const composer = page.getByRole("combobox", { name: /^Message/ });
      await expect(page.getByTestId("composer-enter-to-send-toggle")).toBeHidden();
      await composer.fill("default behavior");
      await composer.press("End");
      await composer.press("Shift+Enter");
      await expect(composer).toHaveValue("default behavior\n");
      await composer.press("Enter");
      if (touch) {
        await expect(composer).toHaveValue("default behavior\n\n");
        await composer.press("Control+Enter");
      }
      await expect(composer).toHaveValue("");
      await composer.fill("saved draft");
      await page.getByTestId("user-menu-trigger").click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByTestId("user-settings");
      await settings.getByTestId("advanced-settings").locator("summary").click();
      const preference = settings.getByRole("switch", { name: "Send with Enter", exact: true });
      await expect(preference).toBeChecked({ checked: !touch });
      await preference.click();
      await expect(preference).toBeChecked({ checked: touch });
      await settings
        .getByTestId("advanced-settings")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await captureScreenshot(
        page,
        testInfo,
        `composer-enter-preference-${touch ? "touch" : "desktop"}`,
      );
      await settings.getByRole("button", { name: "Close user settings" }).click();
      await expect(composer).toHaveValue("saved draft");
      await page.reload();
      await expect(composer).toHaveValue("saved draft");
      await composer.press("End");
      await composer.press("Enter");
      if (touch) {
        await expect(composer).toHaveValue("");
      } else {
        await expect(composer).toHaveValue("saved draft\n");
        await composer.press("Control+Enter");
        await expect(composer).toHaveValue("");
      }
    });
  });
}
