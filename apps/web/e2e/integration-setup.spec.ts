import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("setup exposes all integration choices and saves only the selected provider", async ({
  page,
}, testInfo) => {
  const saved: unknown[] = [];
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          webUrl: "https://example.test/integrations/setup",
          providers: [
            { id: "composio", configured: false },
            { id: "pipedream", configured: false },
          ],
        },
      },
    }),
  );
  await page.route("**/rpc/integrationSetup/save", (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await signup(page, `integration-setup-${Date.now()}@rakazo.test`, "password12", "Setup Test");
  await expect(page.getByRole("heading", { name: "Connect apps" })).toBeVisible();
  for (const name of ["Direct MCP", "Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("API key", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "integration-setup-options");
  await page.getByRole("button", { name: "Pipedream", exact: true }).click();
  await expect(page.getByLabel("Client ID", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Project ID", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Client secret", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "integration-setup-pipedream");
  await page.getByRole("button", { name: "Composio", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("fake-composio-key");
  await captureScreenshot(page, testInfo, "integration-setup-composio");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
  expect(saved).toEqual([{ json: { provider: "composio", apiKey: "fake-composio-key" } }]);
});

test("direct MCP connects a catalog result without asking for a URL and assigns it to the first bot", async ({
  page,
}, testInfo) => {
  let serverId = "";
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "notion.example.test",
              name: "Notion",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "notion",
                  source: "https://mcp.notion.example.test/mcp",
                  auth: null,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    serverId = route.request().postDataJSON().json.serverId;
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  await signup(page, `direct-mcp-setup-${Date.now()}@rakazo.test`, "password12", "Direct MCP");
  await page.getByRole("textbox", { name: "Search apps", exact: true }).fill("Notion");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Server URL" })).toBeHidden();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "integration-setup-direct-connected");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Connected Bot");
  const assigned = page.waitForResponse(
    (response) => response.url().includes("/rpc/mcp/assignments/approve") && response.ok(),
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const response = await assigned;
  expect(response.request().postDataJSON().json.serverId).toBe(serverId);
  await page.waitForURL(/\/app\//);
});
