import { expect, test } from "@playwright/test";
import { signup } from "./helpers";

test("onboarding cannot continue with an empty or failed model catalog", async ({ page }) => {
  let unavailable: "empty" | "failed" = "empty";
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/list", (route) =>
    unavailable === "failed" ? route.abort() : route.fulfill({ json: { json: [] } }),
  );
  const stamp = Date.now();
  await signup(page, `catalog-${stamp}@rakazo.test`, "password12", "Model setup");

  for (const next of ["empty", "failed"] as const) {
    if (next === "failed") {
      unavailable = next;
      await page.reload();
    }
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message Chief" })).toHaveCount(0);
  }
});

test("Ollama Cloud onboarding requires a key before continuing", async ({ page }) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  const stamp = Date.now();
  await signup(page, `ollama-${stamp}@rakazo.test`, "password12", "Model setup");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Ollama Cloud", exact: true }).click();
  await page.getByLabel("Model id", { exact: true }).fill("test-model");
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  const apiKey = page.getByLabel("API key", { exact: true });
  await apiKey.fill("   ");
  await expect(continueButton).toBeDisabled();
  await apiKey.fill("fake-test-key");
  await expect(continueButton).toBeEnabled();
  await apiKey.fill("");
  await expect(continueButton).toBeDisabled();
});
