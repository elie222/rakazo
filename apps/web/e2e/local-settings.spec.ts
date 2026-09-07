import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("local settings open and save integrations without an app session", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let connected = false;
    window.rakazoDesktop = {
      platform: "darwin",
      localSettings: {
        request: async (pathname: string, body: string) => {
          const procedure = pathname.split("/rpc/")[1];
          let json: unknown;
          if (procedure === "integrationSetup/get") {
            json = {
              canConfigure: true,
              needsSetup: !connected,
              providers: [{ id: "composio", configured: connected }],
              webUrl: "https://example.test/integrations/setup",
            };
          } else if (procedure === "integrationSetup/save") {
            const input = JSON.parse(body).json;
            if (input.provider !== "composio" || input.apiKey !== "fake-integration-key")
              throw new Error("Unexpected input");
            connected = true;
            json = { ok: true };
          } else if (procedure === "models/list") {
            json = [
              {
                provider: "openai-compatible",
                providerName: "OpenAI-compatible",
                id: "custom",
                label: "Custom model",
                billing: "",
                placeholder: true,
                auth: "api-key",
              },
            ];
          } else if (procedure === "models/credentials") {
            json = [];
          } else if (procedure === "me") {
            json = {
              userId: "owner",
              spaceId: "default",
              email: "owner@example.test",
              name: "Owner",
              isDeploymentOwner: true,
              needsModel: true,
              defaultProvider: "openai-compatible",
              defaultModel: "custom",
              computerHost: "local",
              canChooseHostComputer: true,
              sandboxProvider: "docker",
              avatarStyle: "robot",
            };
          } else throw new Error(`Unexpected procedure: ${procedure}`);
          return { status: 200, body: JSON.stringify({ json }) };
        },
      },
    } as typeof window.rakazoDesktop;
  });
  await page.goto("/desktop-settings");
  await page.getByRole("button", { name: "Server integrations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Direct MCP", exact: true })).toBeHidden();
  await page.getByLabel("API key", { exact: true }).fill("fake-integration-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await captureScreenshot(page, testInfo, "local-server-integrations-logged-out");
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByText("Models for the server owner’s default space.")).toBeVisible();
  await expect(page.getByLabel("OpenAI-compatible server URL")).toBeVisible();
  await captureScreenshot(page, testInfo, "local-server-models-logged-out");
});

test("ordinary browsers cannot use local settings", async ({ page }) => {
  await page.goto("/desktop-settings");
  await expect(page.getByRole("alert")).toContainText("Could not open local settings");
  await expect(page.getByRole("button", { name: "Models", exact: true })).toBeHidden();
});
