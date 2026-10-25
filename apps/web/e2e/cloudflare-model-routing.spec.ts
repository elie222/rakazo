import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openModelConnection,
  openUserSettings,
  pickReopenedModel,
  rpc,
  signup,
} from "./helpers";

test("Workers AI settings save the account without requiring a gateway", async ({
  page,
}, testInfo) => {
  await signup(page, `workers-settings-${Date.now()}@rakazo.test`, "password12", "Model setup");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  const dialog = await openModelConnection(page, "Cloudflare Workers AI");
  const connect = dialog.getByRole("button", { name: "Connect API key", exact: true });
  await dialog.getByLabel("API key", { exact: true }).fill("workers-fixture-key");
  await expect(connect).toBeDisabled();
  await expect(dialog.getByLabel("Gateway ID", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Account ID", { exact: true }).fill("account-fixture");
  await expect(connect).toBeEnabled();
  await captureScreenshot(page, testInfo, "workers-ai-account-settings");
  await connect.click();
  await expect(dialog).toBeHidden();
  await pickReopenedModel(page);
  await expect(page.getByTestId("model-role-main").getByTestId("model-role-row-1")).toContainText(
    "Cloudflare Workers AI",
  );
  const credentials = await rpc<
    Array<{ provider: string; accountId?: string; gatewayId?: string }>
  >(page, "models/credentials", {});
  expect(credentials.find((entry) => entry.provider === "cloudflare-workers-ai")).toMatchObject({
    accountId: "account-fixture",
  });
  expect(
    credentials.find((entry) => entry.provider === "cloudflare-workers-ai")?.gatewayId,
  ).toBeUndefined();
});

test("Workers AI onboarding requires an account before continuing", async ({ page }, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
  });
  await signup(page, `workers-onboarding-${Date.now()}@rakazo.test`, "password12", "Model setup");
  await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible();
  await chooseOption(
    page.getByRole("combobox", { name: "Provider", exact: true }),
    "Cloudflare Workers AI",
  );
  await page.getByLabel("API key", { exact: true }).fill("workers-fixture-key");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  await expect(page.getByLabel("Gateway ID", { exact: true })).toHaveCount(0);
  await page.getByLabel("Account ID", { exact: true }).fill("account-fixture");
  await expect(next).toBeEnabled();
  await captureScreenshot(page, testInfo, "workers-ai-account-onboarding");
});
