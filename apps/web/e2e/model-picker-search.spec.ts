import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("model dropdown search and provider group headers", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Model picker ${stamp}`;
  await signup(page, `model-picker-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  // OpenRouter has many models so group headers and search are obvious.
  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("openrouter");
  await page.getByRole("button", { name: /OpenRouter/ }).click();

  const modelCombobox = page.getByRole("combobox", { name: "Model", exact: true });
  await modelCombobox.click();

  const modelSearch = page.getByRole("combobox", { name: "Search models" });
  const modelOptions = page.getByRole("listbox", { name: "Model options" });
  await expect(modelSearch).toBeVisible();
  await expect(modelSearch).toHaveAttribute("placeholder", "Search");
  await expect(modelOptions).toBeVisible();
  // Provider section header inside the model listbox (not the provider button).
  await expect(modelOptions.getByText("OpenRouter", { exact: true })).toBeVisible();

  await captureScreenshot(page, testInfo, "model-picker-dropdown-groups");

  await modelSearch.fill("claude");
  const optionTexts = await modelOptions.getByRole("option").allTextContents();
  expect(optionTexts.length).toBeGreaterThan(0);
  expect(optionTexts.every((text) => /claude/i.test(text))).toBe(true);
  await expect(page.getByText("No matching models")).toBeHidden();

  await captureScreenshot(page, testInfo, "model-picker-dropdown-filtered");

  const firstActive = await modelSearch.getAttribute("aria-activedescendant");
  expect(firstActive).toBeTruthy();
  await modelSearch.press("ArrowDown");
  await expect(modelSearch).toBeFocused();
  const afterDown = await modelSearch.getAttribute("aria-activedescendant");
  expect(afterDown).toBeTruthy();
  expect(afterDown).not.toBe(firstActive);

  await modelSearch.press("Home");
  await expect(modelSearch).toBeFocused();
  await expect(modelSearch).toHaveAttribute("aria-activedescendant", firstActive!);

  await modelSearch.press("End");
  await expect(modelSearch).toBeFocused();
  const afterEnd = await modelSearch.getAttribute("aria-activedescendant");
  expect(afterEnd).toBeTruthy();
  expect(afterEnd).not.toBe(firstActive);

  await modelSearch.press("ArrowUp");
  await expect(modelSearch).toBeFocused();
  const afterUp = await modelSearch.getAttribute("aria-activedescendant");
  expect(afterUp).toBeTruthy();
  expect(afterUp).not.toBe(afterEnd);

  const highlighted = page.locator(`[id="${afterUp}"]`);
  const selectedLabel = ((await highlighted.locator("span").first().textContent()) ?? "").trim();
  expect(selectedLabel.length).toBeGreaterThan(0);
  await modelSearch.press("Enter");
  await expect(modelSearch).toBeHidden();
  await expect(modelCombobox).toHaveText(selectedLabel);

  await modelCombobox.click();
  await expect(modelSearch).toBeVisible();
  await modelSearch.fill("no-model-matches-this");
  await expect(page.getByText("No matching models")).toBeVisible();
  await expect(modelOptions.getByRole("option")).toHaveCount(0);
});
