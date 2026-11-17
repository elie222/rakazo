import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

type BotRow = { id: string; name: string; modelProvider: string | null; modelId: string | null };

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
  await picker.click();
  const smart = page.getByRole("option", { name: "e2e-smart" });
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
});
