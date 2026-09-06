import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding model list never labels an older model the latest one", async ({
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

  await page.getByRole("combobox", { name: "Provider" }).click();
  await page.getByRole("option", { name: "Anthropic" }).click();

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  await models.click();
  const options = page.getByRole("listbox").getByRole("option");
  const labels = await options.allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select the alias so the closed picker shows the rewritten label in the screenshot.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await options.filter({ hasText: alias! }).click();

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
