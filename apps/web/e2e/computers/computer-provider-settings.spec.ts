import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { computerProviderDescriptors } from "../../../../packages/adapters/src/providers/computer/fake/fake-computer-settings.test-support";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

async function adminComputers(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
  if (me) {
    me.sandboxProvider = "docker";
    me.isAdmin = true;
    me.computerSettingsEnabled = true;
  }
  await route.fulfill({ response, json: body });
}

test("an admin retries computer settings and selects a provider", async ({ page }, testInfo) => {
  await signup(
    page,
    `computer-settings-${randomUUID()}@rakazo.test`,
    "password12",
    "Computer settings",
  );
  await completeOnboarding(page);
  await page.route("**/rpc/me", adminComputers);
  await page.route("**/rpc/bootstrap", adminComputers);
  let settingsUnavailable = true;
  await page.route(/\/rpc\/computerProvider\/get(\?|$)/, (route) => {
    if (settingsUnavailable) {
      return route.fulfill({
        status: 500,
        json: {
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "INTERNAL_SERVER_ERROR",
          },
        },
      });
    }
    return route.fulfill({
      json: {
        json: {
          provider: "default",
          defaultProvider: "docker",
          providers: computerProviderDescriptors(),
          values: {},
          savedSecrets: {},
        },
      },
    });
  });
  await page.reload();
  const settings = await openUserSettings(page, "computer");
  const setup = settings.getByTestId("computers-setup-settings");
  const loadError = setup.getByRole("alert").filter({
    hasText: "Could not load computer settings",
  });
  await expect(loadError).toHaveText("Could not load computer settings");
  const retry = setup.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await captureScreenshot(page, testInfo, "computer-provider-settings-retry");
  settingsUnavailable = false;
  await retry.click();
  await expect(loadError).toHaveCount(0);
  const form = setup.getByTestId("computer-provider-settings");
  await chooseOption(form.getByLabel("New computers run on"), "Test desktop");
  await form.getByLabel("Desktop ID").fill("ecd-example");
  await form.getByLabel("End user ID").fill("example-user");
  await form.getByLabel("Region").fill("cn-hangzhou");
  await form.getByLabel("Gateway URL").fill("https://gateway.example.com/mcp");
  await expect(form.getByLabel("Access key secret")).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "computer-provider-settings");
  await chooseOption(form.getByLabel("New computers run on"), "Test cloud");
  await expect(form.getByLabel("API key")).toBeVisible();
  await expect(form.getByLabel("Desktop ID")).toHaveCount(0);
});

for (const enabled of [undefined, false]) {
  test(`Computer settings stay hidden when the flag is ${enabled}`, async ({ page }, testInfo) => {
    await signup(page, `computer-hidden-${randomUUID()}@rakazo.test`, "password12", "Settings");
    await completeOnboarding(page);
    const disabledComputers = async (route: Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: Record<string, unknown> };
      const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
      if (me) {
        me.sandboxProvider = "none";
        me.isAdmin = true;
        if (enabled === undefined) delete me.computerSettingsEnabled;
        else me.computerSettingsEnabled = enabled;
      }
      await route.fulfill({ response, json: body });
    };
    await page.route("**/rpc/me", disabledComputers);
    await page.route("**/rpc/bootstrap", disabledComputers);
    await page.reload();
    const settings = await openUserSettings(page);
    await expect(settings.getByTestId("settings-nav-computer")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "computer-settings-hidden");
  });
}
