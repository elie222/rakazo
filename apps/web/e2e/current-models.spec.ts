import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("current subscription models appear in the picker", async ({ page }, testInfo) => {
  await signup(page, `current-models-${Date.now()}@rakazo.test`, "password12", "Model Picker");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  for (const [provider, model, screenshot] of [
    ["Anthropic", "Claude Sonnet 5.5", "model-sonnet-55"],
    ["OpenAI Codex", "GPT-6.1 Sol", "model-sol-61"],
  ]) {
    await page.getByPlaceholder("Search providers").fill(provider!);
    await page
      .getByTestId("model-settings")
      .getByRole("button")
      .filter({ hasText: provider! })
      .first()
      .click();
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("combobox", { name: "Search models" }).fill(model!);
    await expect(page.getByRole("option", { name: model!, exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, screenshot!);
    await page.keyboard.press("Escape");
  }
});
