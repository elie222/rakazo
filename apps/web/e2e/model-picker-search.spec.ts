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
  await expect(modelSearch).toBeVisible();
  await expect(modelSearch).toHaveAttribute("placeholder", "Search");
  await expect(page.getByRole("listbox", { name: "Model options" })).toBeVisible();
  // Provider section header above the filtered/grouped options.
  await expect(page.getByText("OpenRouter", { exact: true }).first()).toBeVisible();

  await captureScreenshot(page, testInfo, "model-picker-dropdown-groups");

  await modelSearch.fill("claude");
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect(page.getByText("No matching models")).toBeHidden();

  await captureScreenshot(page, testInfo, "model-picker-dropdown-filtered");
});
