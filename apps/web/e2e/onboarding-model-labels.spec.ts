import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding model list never labels an older model the latest one", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `model-labels-${stamp}@rakazo.test`, "password12", `Model labels ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.getByRole("button", { name: /OpenRouter/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /ChatGPT.*ChatGPT Plus\/Pro/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Vercel AI Gateway/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-popular-providers");
  await page.getByRole("button", { name: "Show all providers" }).click();
  await page.getByPlaceholder("Search providers and models").fill("anthropic");
  await expect(page.getByRole("button", { name: /OpenRouter/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByRole("button", { name: /Anthropic/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: /Anthropic/ }).first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  const labels = await models.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select a non-default model before filtering the active provider out of the results.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await models.selectOption({ label: alias! });
  const selectedModelId = await models.inputValue();

  await page.getByPlaceholder("Search providers and models").fill("no-provider-or-model");
  const selectedProvider = page.getByRole("button", { name: /Anthropic.*Selected/ });
  await expect(selectedProvider).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("No providers found")).toBeVisible();
  await selectedProvider.click();
  await expect(models).toHaveValue(selectedModelId);
  await page.getByPlaceholder("Search providers and models").fill("anthropic");

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
