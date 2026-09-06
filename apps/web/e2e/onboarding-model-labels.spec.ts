import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding uses compact model selects without misleading latest labels", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: true } },
    });
  });

  const stamp = Date.now();
  await signup(page, `model-labels-${stamp}@rakazo.test`, "password12", `Model labels ${stamp}`);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toContainText("OpenRouter");
  await page.getByLabel("API key").fill("openrouter-only-key");
  await provider.click();
  await expect(page.getByRole("option", { name: "ChatGPT" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Vercel AI Gateway" })).toBeVisible();
  await page.getByRole("option", { name: "Anthropic" }).click();
  await expect(provider).toContainText("Anthropic");
  await expect(page.getByLabel(/API key/)).toHaveValue("");

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  await models.click();
  const labels = await page.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select a non-default model and keep its user-facing alias visible in the compact trigger.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await page.getByRole("option", { name: alias! }).click();
  await expect(models).toContainText(alias!);

  await provider.click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await page.getByRole("button", { name: "Find models" }).click();
  const discovered = page.getByRole("combobox", { name: "Models from server" });
  await expect(discovered).toBeVisible();
  await discovered.click();
  await page.getByRole("option", { name: "Other model…" }).click();
  await expect(page.getByLabel("Model id")).toBeVisible();

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
