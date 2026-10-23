import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("Workers AI settings save the account without requiring a gateway", async ({
  page,
}, testInfo) => {
  await signup(page, `workers-settings-${Date.now()}@rakazo.test`, "password12", "Model setup");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("Cloudflare Workers AI");
  await page.getByRole("button", { name: /^Cloudflare Workers AI( |$)/ }).click();
  const connect = page.getByRole("button", { name: "Connect API key", exact: true });
  await page.getByLabel("API key", { exact: true }).fill("workers-fixture-key");
  await expect(connect).toBeDisabled();
  await expect(page.getByLabel("Gateway ID", { exact: true })).toHaveCount(0);
  await page.getByLabel("Account ID", { exact: true }).fill("account-fixture");
  await expect(connect).toBeEnabled();
  await captureScreenshot(page, testInfo, "workers-ai-account-settings");
  await connect.click();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
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
