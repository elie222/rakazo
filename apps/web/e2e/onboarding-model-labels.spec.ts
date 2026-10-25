import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding requires a model and uses compact model selects without misleading latest labels", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: "openai/gpt-5.5",
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(page, `model-labels-${stamp}@rakazo.test`, "password12", `Model labels ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  // A deployment without a model cannot skip setup or continue without a usable key.
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  // No provider is preselected, and nothing else shows until one is chosen.
  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toContainText("Choose a provider");
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-choose-provider");
  await provider.click();
  await page.getByRole("option", { name: "ChatGPT subscription", exact: true }).click();
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveText("GPT-6 Luna");
  await captureScreenshot(page, testInfo, "onboarding-luna-default");
  await provider.click();
  await page.getByRole("option", { name: "OpenAI API", exact: true }).click();
  await expect(model).toHaveText("GPT-6 Luna");
  await provider.click();
  await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
  await expect(model).toContainText("GPT-6 Luna");
  await page.getByLabel("API key", { exact: true }).fill("   ");
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await expect(continueButton).toBeEnabled();
  await page.getByLabel("API key", { exact: true }).fill("");
  await captureScreenshot(page, testInfo, "onboarding-model-required");

  await expect(provider).toContainText("OpenRouter");
  await page.getByLabel("API key").fill("openrouter-only-key");
  await provider.click();
  const providerMenu = page.getByRole("listbox");
  await expect(providerMenu).toBeVisible();
  // Subscriptions and the common API providers lead; the rest follow the separator.
  const options = await page.getByRole("option").allTextContents();
  expect(options.slice(0, 6)).toEqual([
    "ChatGPT subscription",
    "Claude subscription",
    "OpenAI API",
    "Anthropic API",
    "OpenRouter",
    "Google",
  ]);
  await expect(page.getByRole("option", { name: "Vercel AI Gateway" })).toBeVisible();
  const menu = page.locator('[data-slot="select-content"]');
  const firstOption = page.getByRole("option", { name: "ChatGPT subscription", exact: true });
  await expect
    .poll(async () => {
      const menuBounds = await menu.boundingBox();
      const optionBounds = await firstOption.boundingBox();
      return menuBounds && optionBounds ? optionBounds.x - menuBounds.x : 0;
    })
    .toBeGreaterThan(0);
  await captureScreenshot(page, testInfo, "onboarding-provider-menu");
  await page.getByRole("option", { name: "Anthropic API", exact: true }).click();
  await expect(provider).toContainText("Anthropic API");
  await expect(model).toHaveText("Claude Haiku 5.5");
  await captureScreenshot(page, testInfo, "onboarding-haiku-default");
  await expect(page.getByRole("button", { name: /Sign in with Claude/ })).toHaveCount(0);
  await expect(page.getByLabel(/API key/)).toHaveValue("");

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  await models.click();
  await expect(page.getByRole("option", { name: /\(auto-updates\)/ }).first()).toBeVisible();
  const labels = await page.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select a non-default model and keep its user-facing alias visible in the compact trigger.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await page.getByRole("option", { name: alias! }).click();
  await expect(models).toContainText(alias!);

  await page.route("**/rpc/models/probeOpenAiCompatible", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: ["probed-model"] } }),
    });
  });
  await provider.click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  const manualModel = page.getByLabel("Model id");
  await expect(manualModel).toBeVisible();
  // Typing before the first probe must keep freeform even if the probe returns that id.
  await manualModel.fill("probed-model");
  const firstProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await firstProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(page.getByRole("combobox", { name: "Models from server" })).toHaveCount(0);
  await page.getByRole("button", { name: "Use a found model" }).click();
  const discovered = page.getByRole("combobox", { name: "Models from server" });
  await expect(discovered).toBeVisible();
  await expect(discovered).toContainText("probed-model");
  await discovered.click();
  await page.getByRole("option", { name: "Other model…" }).click();
  await expect(manualModel).toBeVisible();
  // Typing a discovered id (or its prefix) must keep the freeform field.
  await manualModel.fill("probed-model");
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  // Re-probe while the typed id matches a discovered model must stay freeform.
  const reProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await reProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(page.getByRole("combobox", { name: "Models from server" })).toHaveCount(0);
  // Editing the server URL must not drop Other model… mode either.
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8091/v1");
  const editedUrlProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await editedUrlProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(page.getByRole("combobox", { name: "Models from server" })).toHaveCount(0);
  await manualModel.fill("probed-model-custom");
  await expect(manualModel).toHaveValue("probed-model-custom");

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
