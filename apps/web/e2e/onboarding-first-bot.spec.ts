import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("connect model uses a compact provider Select", async ({ page }, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: true } },
    });
  });

  const stamp = Date.now();
  await signup(page, `connect-model-${stamp}@rakazo.test`, "password12", `Connect model ${stamp}`);

  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("combobox", { name: "Provider" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show all providers" })).toBeHidden();
  await captureScreenshot(page, testInfo, "01-connect-model");
});

test("first bot continues with a prefilled name in one click", async ({ page }, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false } },
    });
  });

  const stamp = Date.now();
  await signup(page, `first-bot-${stamp}@rakazo.test`, "password12", `First bot ${stamp}`);

  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeHidden();
  const name = page.locator("label:has-text('Name') input");
  await expect(name).toHaveValue("Assistant");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "02-create-first-bot");

  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/create") && response.ok(),
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await created;
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByText("Assistant").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "03-onboarding-complete");
});
