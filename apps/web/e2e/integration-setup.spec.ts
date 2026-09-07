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
  await page.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Server URL" })).toBeHidden();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "integration-setup-direct-connected");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Connected Bot");
  let createCalls = 0;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createCalls += 1;
    await createGate;
    await route.continue();
  });

  const assigned = page.waitForResponse(
    (response) => response.url().includes("/rpc/mcp/assignments/approve") && response.ok(),
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect.poll(() => createCalls).toBe(1);
  releaseCreate();
  const response = await assigned;
  expect(response.request().postDataJSON().json.serverId).toBe(serverId);
  await page.waitForURL(/\/app\//);
});

test("Executor reconnect saves a replacement token before authorization", async ({ page }) => {
  await signup(page, `executor-reconnect-${Date.now()}@rakazo.test`, "password12", "Executor Test");
  await expect(page.getByRole("heading", { name: "Connect apps" })).toBeVisible();
  const server = await page.evaluate(async () => {
    const response = await fetch("/rpc/mcp/servers/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rakazo-space-id": localStorage.getItem("rakazo:space-id") ?? "",
      },
      body: JSON.stringify({
        json: {
          slug: "existing-executor",
          name: "Executor",
          transport: "streamable_http",
          endpoint: "http://localhost:8765/mcp",
          secret: "fake-old-token",
          headers: { "X-Test": "fake-header" },
        },
      }),
    });
    if (!response.ok) throw new Error(`Server creation failed: ${response.status}`);
    return (await response.json()).json;
  });
  let saved = false;
  await page.route("**/rpc/mcp/servers/update", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: { id: server.id, secret: "fake-new-token" },
    });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const updated = (await response.json()).json;
    expect(updated.headerKeys).toEqual(["X-Test"]);
    expect(updated.revision).toBe(server.revision + 1);
    saved = true;
    await route.fulfill({ response });
  });
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    expect(saved).toBe(true);
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  await page.getByRole("button", { name: "Executor", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Server URL", exact: true })
    .fill("http://localhost:8765/mcp");
  await page.getByLabel("Access token", { exact: true }).fill("fake-new-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page.getByRole("alert")).toBeHidden();
});
