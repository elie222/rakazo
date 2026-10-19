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

test("text-only models have a subtle image warning", async ({ page }, testInfo) => {
  await page.route("**/rpc/models/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json: Array<{ provider: string; id: string; label: string; images?: boolean }>;
    };
    const template = body.json.find((entry) => entry.provider === "openrouter");
    if (!template) throw new Error("Missing OpenRouter catalog fixture");
    await route.fulfill({
      response,
      json: {
        ...body,
        json: [
          ...body.json.filter((entry) => entry.provider !== "openrouter"),
          { ...template, id: "fixture-vision", label: "Vision model", images: true },
          { ...template, id: "fixture-text", label: "Text-only model", images: false },
        ],
      },
    });
  });
  await signup(page, `text-only-models-${Date.now()}@rakazo.test`, "password12", "Model Picker");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("OpenRouter");
  await page.getByRole("button", { name: /OpenRouter/ }).click();

  const picker = page.getByRole("combobox", { name: "Model", exact: true });
  await picker.click();
  const textOnly = page.getByRole("option", { name: "Text-only model", exact: true });
  const vision = page.getByRole("option", { name: "Vision model", exact: true });
  await expect(textOnly.getByTitle("Can't read images")).toBeVisible();
  await expect(textOnly).toHaveAccessibleDescription("Can't read images");
  await expect(vision.getByTitle("Can't read images")).toHaveCount(0);
  await expect(vision).toHaveAccessibleDescription("");
  await captureScreenshot(page, testInfo, "model-picker-text-only-warning");

  await textOnly.click();
  await expect(picker.getByTitle("Can't read images")).toBeVisible();
  await expect(picker).toHaveAccessibleDescription("Can't read images");
  await expect(page.getByRole("listbox", { name: "Model options" })).toBeHidden();
  await captureScreenshot(page, testInfo, "model-picker-text-only-selected");

  await picker.click();
  await vision.click();
  await expect(picker.getByTitle("Can't read images")).toHaveCount(0);
  await expect(picker).toHaveAccessibleDescription("");
});
