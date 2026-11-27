import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

test("favorite models stay pinned across chat and Settings", async ({ page }, testInfo) => {
  await signup(page, `model-favorites-${Date.now()}@rakazo.test`, "password12", "Model Favorites");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const models = [
    { id: "e2e-fast", provider: "openai", label: "OpenAI" },
    { id: "e2e-smart", provider: "anthropic", label: "Anthropic" },
  ];
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: models.map(({ id, provider, label }) => ({
          id: `cred-${provider}`,
          provider,
          label,
          hasKey: true,
          isDefault: provider === "openai",
          enabledModelIds: [id],
        })),
      },
    }),
  );
  await page.route(/\/rpc\/models\/(list|forRole)$/, (route) =>
    route.fulfill({
      json: {
        json: models.map(({ id, provider, label }) => ({
          id,
          provider,
          label: id,
          providerName: label,
          billing: "",
        })),
      },
    }),
  );
  await rpc(page, "preferences/update", { chatPreferences: { composerModelPicker: true } });
  await page.reload();

  const picker = page.getByTestId("composer-bar").getByRole("button", { name: /^Model:/ });
  const favorites = page.getByRole("group", { name: "Favorites", exact: true });
  const addSmart = page.getByRole("button", {
    name: "Add e2e-smart (Anthropic) to favorites",
    exact: true,
  });
  const addFast = page.getByRole("button", {
    name: "Add e2e-fast (OpenAI) to favorites",
    exact: true,
  });
  const favoriteNames = ["e2e-smart (Anthropic)", "e2e-fast (OpenAI)"];

  await picker.click();
  await expect(favorites).toHaveCount(0);
  await expect(addFast).toBeVisible();
  await addSmart.hover();
  await expect(addSmart).toHaveCSS("opacity", "1");
  await captureScreenshot(page, testInfo, "chat-model-picker-before-favorites");

  // Star in reverse provider order and wait for each real save before the next action.
  for (const star of [addSmart, addFast]) {
    const saved = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/rpc/preferences/update" && response.ok(),
    );
    await star.click();
    await saved;
  }
  const chatOptions = page.getByRole("listbox");
  await expect(chatOptions.getByRole("group").first()).toHaveAccessibleName("Favorites");
  await expect(favorites.getByRole("option")).toHaveCount(2);
  for (const [index, name] of favoriteNames.entries()) {
    const option = favorites.getByRole("option").nth(index);
    await expect(option).toHaveAccessibleName(name);
    const star = option.getByRole("button", { name: `Remove ${name} from favorites`, exact: true });
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star.locator("svg")).toHaveCSS(
      "fill",
      await star.evaluate((el) => getComputedStyle(el).color),
    );
  }
  await captureScreenshot(page, testInfo, "chat-model-picker-favorites");

  await page.reload();
  await picker.click();
  await expect(favorites.getByRole("option")).toHaveText([/e2e-smart/, /e2e-fast/]);

  await page.keyboard.press("Escape");
  await openUserSettings(page, "models");
  await page
    .getByTestId("model-role-main")
    .getByRole("button", { name: /^(Change |Choose a model$|Connect a model$)/ })
    .first()
    .click();
  const roleFavorites = page.getByRole("listbox", { name: "Model options" }).getByRole("group", {
    name: "Favorites",
    exact: true,
  });
  await expect(roleFavorites.getByRole("option")).toHaveText([/e2e-smart/, /e2e-fast/]);
  await captureScreenshot(page, testInfo, "settings-model-role-picker-favorites");

  await roleFavorites.getByRole("button", { name: "Remove e2e-smart from favorites" }).click();
  await expect(roleFavorites.getByRole("option")).toHaveText([/e2e-fast/]);
});
