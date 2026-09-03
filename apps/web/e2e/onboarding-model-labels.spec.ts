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

  await page.getByPlaceholder("Search providers and models").fill("anthropic");
  await page
    .getByRole("button", { name: /Anthropic/ })
    .first()
    .click();

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  const labels = await models.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select the alias so the closed native picker shows the rewritten label in the screenshot.
  const alias = labels.find((label) => label.includes("(auto-updates)"));
  expect(alias).toBeTruthy();
  await models.selectOption({ label: alias! });

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
