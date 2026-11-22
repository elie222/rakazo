import { expect, test } from "@playwright/test";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

type BotRow = { id: string; name: string; modelProvider: string | null; modelId: string | null };

test("a missing model opens Models in account Settings from chat", async ({ page }, testInfo) => {
  await signup(page, `composer-connect-${Date.now()}@rakazo.test`, "password12", "Connect Model");
  await completeOnboarding(page);
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, json: { ...body.json, needsModel: true } } });
  });
  await page.route("**/rpc/models/credentials", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/threads/send", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: MODEL_REQUIRED_SEND_ERROR,
        },
      },
    }),
  );
  await page.route("**/rpc/models/role", (route) =>
    route.request().postDataJSON().json.role === "main"
      ? route.fulfill({ json: { json: { primary: null, backups: [], deploymentPrimary: null } } })
      : route.fallback(),
  );

  await page.reload();
  const draft = page.getByRole("combobox", { name: /^Message/ });
  await draft.fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: MODEL_REQUIRED_SEND_ERROR }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  const main = settings.getByTestId("model-role-main");
  const connect = main.getByRole("button", { name: "Connect a model", exact: true });
  await expect(connect).toBeVisible();
  await expect(main.getByRole("button", { name: "Add fallback" })).toHaveCount(0);
  await expect(settings.getByTestId("model-role-approval")).toHaveCount(0);
  await expect(settings.getByTestId("model-providers")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "composer-connect-model-settings");
  await connect.click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeVisible();
});

test("the chat's model can be changed from the message box once turned on", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `composer-model-${stamp}@rakazo.test`, "password12", "Composer Model");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = new URL(page.url()).pathname.split("/").at(-1)!;
  const bot = (await rpc<BotRow[]>(page, "bots/list", {})).find((row) => row.id === botId)!;

  // Two connected models, so there is something to switch between.
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "cred-e2e",
            provider: "openai",
            label: "OpenAI",
            hasKey: true,
            isDefault: true,
            enabledModelIds: ["e2e-fast", "e2e-smart"],
          },
        ],
      },
    }),
  );
  let sent: Record<string, unknown> | null = null;
  await page.route("**/rpc/bots/update", async (route) => {
    sent = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    await route.fulfill({
      json: { json: { ...bot, modelProvider: sent.modelProvider, modelId: sent.modelId } },
    });
  });

  const composer = page.getByTestId("composer-bar");
  await expect(composer).toBeVisible();
  // Off by default.
  await expect(composer.getByRole("button", { name: /^Model/ })).toHaveCount(0);

  const settings = await openUserSettings(page);
  const toggle = settings.getByTestId("composer-model-picker-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "composer-model-picker-setting");

  await page.goto(`/app/${botId}`);
  const picker = composer.getByRole("button", { name: /^Model/ });
  await expect(picker).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-model-picker");
  // Hovering names the keys that open the list and step its thinking.
  await picker.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("Model");
  await captureScreenshot(page, testInfo, "composer-model-picker-shortcuts");
  await page.getByRole("combobox", { name: /^Message/ }).focus();
  const smart = page.getByRole("option", { name: "e2e-smart" });
  // The same chord opens the list from the message box and closes it again.
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(smart).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(smart).toHaveCount(0);
  await picker.click();
  await expect(smart).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-model-picker-open");
  await smart.click();
  await expect(picker).toContainText("e2e-smart");
  expect(sent).toMatchObject({
    botId,
    modelProvider: "openai",
    modelId: "e2e-smart",
    thinkingLevel: null,
  });

  // A write outside the settings UI reaches the open chat through the live stream.
  await rpc(page, "preferences/update", { chatPreferences: { composerModelPicker: false } });
  await expect(picker).toHaveCount(0);
  await rpc(page, "preferences/update", { chatPreferences: { composerModelPicker: true } });
  await expect(picker).toBeVisible();
});

test("the message box lists a provider's newest models first", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `composer-model-order-${stamp}@rakazo.test`, "password12", "Model Order");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = new URL(page.url()).pathname.split("/").at(-1)!;

  // Enabled out of order, so the list has to sort them.
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "cred-e2e-order",
            provider: "openai",
            label: "OpenAI",
            hasKey: true,
            isDefault: true,
            enabledModelIds: ["demo-4.1", "demo-5", "demo-4.5"],
          },
        ],
      },
    }),
  );

  const settings = await openUserSettings(page);
  const toggle = settings.getByTestId("composer-model-picker-toggle");
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.goto(`/app/${botId}`);
  const picker = page.getByTestId("composer-bar").getByRole("button", { name: /^Model/ });
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByRole("option", { name: /^demo-/ })).toHaveText([
    /demo-5/,
    /demo-4\.5/,
    /demo-4\.1/,
  ]);
  await captureScreenshot(page, testInfo, "composer-model-picker-newest-first");
});
