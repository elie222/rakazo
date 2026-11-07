import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("usage sorting separates model order from quota direction", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({ response, json: { json: { ...body.json, needsModel: false } } });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
  await signup(page, `usage-sort-${Date.now()}@rakazo.test`, "password12", "Usage sort");
  await completeOnboarding(page);

  const credentials = [
    { id: "usage-sort-go", provider: "opencode-go", label: "OpenCode Go", authKind: "api_key" },
    {
      id: "usage-sort-goat",
      provider: "openai-compatible",
      label: "CommandCode GOAT",
      authKind: "api_key",
    },
    {
      id: "usage-sort-codex",
      provider: "openai-codex",
      label: "owner@example.test",
      authKind: "oauth",
    },
    { id: "usage-sort-claude", provider: "anthropic", label: "Claude", authKind: "oauth" },
  ].map((credential) => ({ ...credential, hasKey: credential.authKind === "api_key" }));
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({ json: { json: credentials } }),
  );
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          { provider: "opencode-go", providerName: "OpenCode Go" },
          { provider: "openai-compatible", providerName: "CommandCode GOAT" },
          { provider: "openai-codex", providerName: "OpenAI Codex" },
          { provider: "anthropic", providerName: "Anthropic" },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/role", (route) => {
    const { role } = route.request().postDataJSON().json as { role: string };
    const order =
      role === "main"
        ? ["usage-sort-codex", "usage-sort-go", "usage-sort-goat", "usage-sort-claude"]
        : ["usage-sort-claude", "usage-sort-goat", "usage-sort-codex", "usage-sort-go"];
    const choices = order.map((id) => ({
      provider: credentials.find((credential) => credential.id === id)!.provider,
      credentialId: id,
      modelId: "fixture/model",
    }));
    return route.fulfill({ json: { json: { primary: choices[0], backups: choices.slice(1) } } });
  });
  await page.route("**/rpc/models/quota", (route) => {
    const { credentialId } = route.request().postDataJSON().json as { credentialId: string };
    const remaining = {
      "usage-sort-go": 80,
      "usage-sort-goat": 60,
      "usage-sort-codex": 40,
      "usage-sort-claude": 20,
    }[credentialId]!;
    return route.fulfill({
      json: {
        json: {
          credentialId,
          status: "fresh",
          observedAt: "2030-03-17T12:00:00.000Z",
          checkedAt: "2030-03-17T12:00:00.000Z",
          windows: [
            {
              id: "seven_day",
              usedPercent: 100 - remaining,
              resetsAt: "2030-03-20T12:00:00.000Z",
              modelIds: null,
            },
          ],
        },
      },
    });
  });

  const settings = await openUserSettings(page, "usage");
  const usage = settings.getByTestId("usage-settings");
  const sortBy = usage.getByTestId("usage-sort-order");
  await expect(sortBy).toBeVisible();
  await sortBy.click();
  await expect(page.getByRole("option", { name: "Remaining quota", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "usage-sort-controls");
  await page.keyboard.press("Escape");

  await sortBy.click();
  await page.getByRole("option", { name: "Approval model", exact: true }).click();
  const providerRows = usage.locator(
    '[data-testid^="provider-quota-"]:not([data-testid="provider-quota-stack"])',
  );
  const invertOrder = usage.getByTestId("usage-sort-inverted");
  await expect(providerRows.nth(0)).toContainText("Claude subscription");
  await expect(providerRows.nth(1)).toContainText("CommandCode GOAT");
  await expect(invertOrder).toContainText("Backups first");
  await captureScreenshot(page, testInfo, "usage-approval-order");
  await invertOrder.click();
  await expect(invertOrder).toHaveAttribute("aria-pressed", "true");
  await expect(providerRows.nth(0)).toContainText("OpenCode Go");
  await expect(providerRows.nth(3)).toContainText("Claude subscription");

  await sortBy.click();
  await page.getByRole("option", { name: "Remaining quota", exact: true }).click();
  await expect(invertOrder).toContainText("Least remaining");
  await expect(invertOrder).toHaveAttribute("aria-pressed", "true");
  await expect(providerRows.nth(0)).toContainText("Claude subscription");
  await expect(providerRows.nth(3)).toContainText("OpenCode Go");

  await sortBy.click();
  await page.getByRole("option", { name: "Alphabetical", exact: true }).click();
  await expect(invertOrder).toContainText("Z–A");
  await expect(invertOrder).toHaveAttribute("aria-pressed", "true");
  await expect(providerRows.nth(0)).toContainText("OpenCode Go");
  await expect(providerRows.nth(3)).toContainText("Claude subscription");
});
