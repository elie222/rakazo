import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { DeploymentModelSettings, ModelCatalogEntry } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  makeAdmin,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("an admin adds a provider for everyone without their own", async ({ page }, testInfo) => {
  await signup(page, `deployment-models-${randomUUID()}@rakazo.test`, "password12", "Models admin");
  await completeOnboarding(page);
  // Providers and models come from the server's catalog; the deployment settings are admin-only,
  // so the test serves them.
  const catalog = await rpc<ModelCatalogEntry[]>(page, "models/list", null);
  const keyed = new Map<string, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    if (entry.placeholder || entry.auth !== "api-key" || entry.routingFields?.length) continue;
    keyed.set(entry.provider, [...(keyed.get(entry.provider) ?? []), entry]);
  }
  const [environment = [], added = []] = [...keyed.values()];
  const [environmentDefault] = environment;
  const [addedModel] = added;
  if (!environmentDefault || !addedModel)
    throw new Error("The catalog lists too few key providers");
  const providerName = (entry: ModelCatalogEntry) => entry.providerName ?? entry.provider;
  const connection = (models: ModelCatalogEntry[], saved: boolean) => ({
    provider: models[0]!.provider,
    name: providerName(models[0]!),
    saved,
    models: models.map((model) => ({ id: model.id, label: model.label })),
  });
  let settings: DeploymentModelSettings = {
    defaultModel: null,
    effectiveDefault: { provider: environmentDefault.provider, modelId: environmentDefault.id },
    allowedModels: null,
    effectiveAllowedModels: [`${environmentDefault.provider}:*`],
    connections: [connection(environment, false)],
    providers: [...keyed.values()].map(([entry]) => ({
      id: entry!.provider,
      name: providerName(entry!),
    })),
  };
  const connects: unknown[] = [];
  const updates: unknown[] = [];
  await page.route("**/rpc/me", (route) => makeAdmin(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, "bootstrap"));
  await page.route(/\/rpc\/models\/deployment\/get(\?|$)/, (route) =>
    route.fulfill({ json: { json: settings } }),
  );
  await page.route(/\/rpc\/models\/deployment\/connect(\?|$)/, (route) => {
    connects.push((route.request().postDataJSON() as { json?: unknown }).json);
    settings = { ...settings, connections: [...settings.connections, connection(added, true)] };
    return route.fulfill({ json: { json: settings } });
  });
  await page.route(/\/rpc\/models\/deployment\/update(\?|$)/, (route) => {
    const update = (route.request().postDataJSON() as { json: { allowedModels: string[] } }).json;
    updates.push(update);
    settings = {
      ...settings,
      allowedModels: update.allowedModels,
      effectiveAllowedModels: update.allowedModels,
    };
    return route.fulfill({ json: { json: settings } });
  });
  await page.reload();

  const modelSettings = await openUserSettings(page, "models");
  const block = modelSettings.getByTestId("deployment-model-settings");
  await expect(block.getByRole("heading", { name: "Default for everyone" })).toBeVisible();
  await expect(block.getByLabel("Model", { exact: true })).toHaveValue("");
  await expect(block.getByLabel("Model", { exact: true }).locator("option").first()).toHaveText(
    `Default (${environmentDefault.label})`,
  );
  const addedName = providerName(addedModel);
  await block.getByRole("button", { name: "Add provider", exact: true }).click();
  await block.getByLabel("Provider", { exact: true }).selectOption(addedModel.provider);
  await block.getByLabel("API key", { exact: true }).fill("test-deployment-model-key");
  await block.getByRole("button", { name: "Save", exact: true }).click();

  const members = block.getByRole("heading", { name: "Members can also choose" });
  await expect(members).toBeVisible();
  const addedSwitch = block.getByRole("switch", { name: addedName, exact: true });
  await expect(addedSwitch).not.toBeChecked();
  await addedSwitch.click();
  await expect(addedSwitch).toBeChecked();
  await expect(
    block.getByRole("switch", { name: providerName(environmentDefault), exact: true }),
  ).toBeChecked();
  // Only a connection saved here can be removed; the environment's stays.
  await expect(block.getByRole("button", { name: `Remove ${addedName}` })).toBeVisible();
  await expect(block.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  expect(connects).toEqual([
    { provider: addedModel.provider, apiKey: "test-deployment-model-key" },
  ]);
  expect(updates).toEqual([
    { allowedModels: [`${environmentDefault.provider}:*`, `${addedModel.provider}:*`] },
  ]);
  await members.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "deployment-model-settings");
});
