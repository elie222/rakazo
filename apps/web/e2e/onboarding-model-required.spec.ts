import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding requires a model when the deployment has none", async ({ page }, testInfo) => {
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
          defaultModel: "openai/gpt-5.6-luna",
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(
    page,
    `model-required-${stamp}@rakazo.test`,
    "password12",
    `Model required ${stamp}`,
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("   ");
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await expect(continueButton).toBeEnabled();
  await page.getByLabel("API key", { exact: true }).fill("");
  await captureScreenshot(page, testInfo, "onboarding-model-required");
});

for (const unavailable of ["empty", "failed"] as const) {
  test(`onboarding cannot continue with a ${unavailable} model catalog`, async ({ page }) => {
    await page.route("**/rpc/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
    });
    await page.route("**/rpc/models/list", (route) =>
      unavailable === "failed" ? route.abort() : route.fulfill({ json: { json: [] } }),
    );
    const stamp = Date.now();
    await signup(page, `catalog-${unavailable}-${stamp}@rakazo.test`, "password12", "Model setup");
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message Chief" })).toHaveCount(0);
  });
}
