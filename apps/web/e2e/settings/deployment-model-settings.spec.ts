import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { DeploymentModelSettings } from "@rakazo/contracts";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

async function asAdmin(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
  if (me) me.isAdmin = true;
  await route.fulfill({ response, json: body });
}

const settings: DeploymentModelSettings = {
  provider: null,
  modelId: null,
  keySaved: false,
  providers: [
    {
      id: "example-provider",
      name: "Example Provider",
      models: [
        { id: "example-small", label: "Example Small" },
        { id: "example-large", label: "Example Large" },
      ],
    },
    { id: "other-provider", name: "Other Provider", models: [{ id: "other", label: "Other" }] },
  ],
};

test.afterEach(async ({ page }) => {
  // Finish intercepted responses before the browser context is disposed.
  await page.unrouteAll({ behavior: "wait" });
});

test("an admin sets the model for everyone without a model of their own", async ({
  page,
}, testInfo) => {
  await signup(page, `deployment-model-${randomUUID()}@rakazo.test`, "password12", "Admin");
  await completeOnboarding(page);
  await page.route("**/rpc/me", asAdmin);
  await page.route("**/rpc/bootstrap", asAdmin);
  let saved = settings;
  const updates: unknown[] = [];
  await page.route(/\/rpc\/models\/deployment\/get(\?|$)/, (route) =>
    route.fulfill({ json: { json: saved } }),
  );
  await page.route(/\/rpc\/models\/deployment\/update(\?|$)/, async (route) => {
    const input = (route.request().postDataJSON() as { json: Record<string, string> }).json;
    updates.push(input);
    saved = { ...settings, provider: input.provider!, modelId: input.modelId!, keySaved: true };
    await route.fulfill({ json: { json: saved } });
  });
  await page.reload();
  await openUserSettings(page, "models");
  const block = page.getByTestId("deployment-model-settings");
  await expect(block.getByRole("heading", { name: "Default for everyone" })).toBeVisible();
  await chooseOption(block.getByLabel("Provider"), "Example Provider");
  await block.getByLabel("API key").fill("fake-admin-key");
  await chooseOption(block.getByLabel("Model"), "Example Large");
  await captureScreenshot(page, testInfo, "deployment-model-settings");
  await block.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => updates)
    .toEqual([
      { provider: "example-provider", modelId: "example-large", apiKey: "fake-admin-key" },
    ]);
  // The key never comes back: the field only says one is saved.
  await expect(block.getByLabel("API key")).toHaveValue("");
  await expect(block.getByLabel("API key")).toHaveAttribute("placeholder", "Saved");
});

test("members who are not admins never see it", async ({ page }) => {
  await signup(page, `deployment-model-member-${randomUUID()}@rakazo.test`, "password12", "Member");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await expect(page.getByTestId("model-role-main")).toBeVisible();
  await expect(page.getByTestId("deployment-model-settings")).toHaveCount(0);
});
