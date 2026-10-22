import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, expandAdvancedSection, signup } from "./helpers";

const credentialsTemplate = `{
  "installed": {
    "client_id": "{{oauth.client_id}}",
    "client_secret": "{{oauth.client_secret}}"
  }
}`;

function stdioServer(overrides: Partial<McpServer>): McpServer {
  return {
    id: "mcp-health-server",
    spaceId: "mcp-health-workspace",
    slug: "gmail",
    name: "Gmail",
    description: "",
    transport: "stdio",
    endpoint: null,
    command: "npx",
    args: ["-y", "@klodr/gmail-mcp@2.0.2"],
    envKeys: [],
    fileKeys: [],
    headerKeys: [],
    hasSecret: false,
    oauthStatus: "connected",
    oauthClientId: "google-client",
    health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
    enabled: true,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

test("adds a stdio MCP server with encrypted environment variables", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-stdio-${stamp}@rakazo.test`, "password12", "MCP stdio");
  await completeOnboarding(page);

  const servers: McpServer[] = [];
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: servers }),
    });
  });
  await page.context().route("**/rpc/mcp/servers/create", async (route) => {
    const { json } = route.request().postDataJSON() as { json: Record<string, unknown> };
    expect(json).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "invoices-mcp@1.0.0"],
      env: {
        INVOICES_API_ID: "id-value",
        INVOICES_API_SECRET: "secret-value",
        GOOGLE_ACCESS_TOKEN: "{{oauth.access_token}}",
      },
      files: { GOOGLE_OAUTH_CREDENTIALS: credentialsTemplate },
      oauthClient: {
        clientId: "google-client",
        clientSecret: "google-secret",
        authorizationServer: "https://accounts.google.com",
        scope: "openid email",
        authorizationParams: "access_type=offline&prompt=consent",
      },
    });
    expect(json.env).not.toHaveProperty("GOOGLE_OAUTH_CREDENTIALS");
    const created: McpServer = {
      id: "mcp-stdio-server",
      spaceId: "mcp-stdio-workspace",
      slug: "invoices",
      name: "Invoices",
      description: "",
      transport: "stdio",
      endpoint: null,
      command: "npx",
      args: ["-y", "invoices-mcp@1.0.0"],
      envKeys: ["INVOICES_API_ID", "INVOICES_API_SECRET", "GOOGLE_ACCESS_TOKEN"],
      fileKeys: ["GOOGLE_OAUTH_CREDENTIALS"],
      headerKeys: [],
      hasSecret: true,
      oauthStatus: "none",
      oauthClientId: "google-client",
      health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
      enabled: true,
      revision: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    servers.push(created);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: created }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expandAdvancedSection(page.getByTestId("integrations-advanced"));
  await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();

  await page.getByLabel("Server name").fill("Invoices");
  await page.getByRole("tab", { name: "STDIO", exact: true }).click();
  await page.getByLabel("Command").fill("npx");
  await page.getByLabel("Arguments").fill("-y invoices-mcp@1.0.0");
  await page.getByText("Advanced", { exact: true }).click();

  const names = page.getByRole("textbox", { name: "Name", exact: true });
  const values = page.getByLabel("Value", { exact: true });
  // Names are normalized to the environment-variable form the server accepts.
  await names.nth(0).fill("123-key");
  await expect(names.nth(0)).toHaveValue("_123_KEY");
  await names.nth(0).fill("invoices-api-id");
  await expect(names.nth(0)).toHaveValue("INVOICES_API_ID");
  await values.nth(0).fill("id-value");
  await expect(values.nth(0)).toHaveAttribute("type", "password");
  await expect(values.nth(0)).toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(1).fill("invoices-api-id");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  await names.nth(1).fill("1password-token");
  await expect(names.nth(1)).toHaveValue("_1PASSWORD_TOKEN");
  await names.nth(1).fill("INVOICES_API_SECRET");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);
  await values.nth(1).fill("secret-value");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(2).fill("invoices-api-id");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  expect(servers).toHaveLength(0);
  await page.getByRole("button", { name: "Remove", exact: true }).nth(2).click();
  await expect(names).toHaveCount(2);
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);

  // The OAuth client is host-managed: the grant reaches the process through a visible reference.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(2).fill("GOOGLE_ACCESS_TOKEN");
  await values.nth(2).fill("{{oauth.access_token}}");
  await expect(values.nth(2)).toHaveAttribute("type", "text");
  await expect(values.nth(0)).toHaveAttribute("type", "password");
  // A file row hands the process a path to a file holding the template (visible, multi-line).
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await names.nth(3).fill("GOOGLE_ACCESS_TOKEN");
  await page.getByRole("button", { name: "File", exact: true }).nth(3).click();
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "mcp-stdio-duplicate-names");
  await names.nth(3).fill("GOOGLE_OAUTH_CREDENTIALS");
  await expect(page.getByText("Each name can be used once.", { exact: true })).toHaveCount(0);
  await expect(values.nth(3)).toHaveJSProperty("tagName", "TEXTAREA");
  await values.nth(3).fill(credentialsTemplate);
  await expect(values.nth(3)).toHaveAttribute("autocomplete", "off");
  await expect(values.nth(3)).toHaveAttribute("spellcheck", "false");
  await expect(page.getByRole("button", { name: "File", exact: true }).nth(3)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "File", exact: true }).nth(0)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByLabel("Redirect URI")).toHaveCount(0);
  await page.getByLabel("OAuth client ID (optional)").fill("google-client");
  await page.getByLabel("OAuth client secret (optional)").fill("google-secret");
  await page.getByLabel("Authorization server").fill("https://accounts.google.com");
  await page.getByLabel("Scopes (optional)").fill("openid email");
  await page
    .getByLabel("Authorization parameters (optional)")
    .fill("access_type=offline&prompt=consent");
  await expect(page.getByLabel("Redirect URI")).toHaveValue(/\/mcp\/oauth\/callback$/);
  await expect(page.getByText("Use {{oauth.access_token}} for the access token.")).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-stdio-env-form");

  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByText("Invoices", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(names).toHaveCount(1);
  await expect(names.nth(0)).toHaveValue("");
  await expect(values.nth(0)).toHaveValue("");
  await expect(values.nth(0)).toHaveJSProperty("tagName", "INPUT");
  await expect(page.getByLabel("OAuth client ID (optional)")).toHaveValue("");
  await expect(page.getByLabel("Authorization server")).toHaveCount(0);
});

test("shows MCP server health, error details, and tests the connection on demand", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-health-${stamp}@rakazo.test`, "password12", "MCP health");
  await completeOnboarding(page);

  const failure = "npm error code ETIMEDOUT\nMCP error -32000: Connection closed";
  let server = stdioServer({
    health: {
      status: "error",
      message: failure,
      toolCount: null,
      checkedAt: new Date().toISOString(),
    },
  });
  let testCalls = 0;
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [server] }),
    });
  });
  await page.context().route("**/rpc/mcp/servers/test", async (route) => {
    testCalls += 1;
    const { json } = route.request().postDataJSON() as { json: { id: string } };
    expect(json).toEqual({ id: server.id });
    // The first test is slow and finishes healthy, so the button's busy state is observable.
    await new Promise((resolve) => setTimeout(resolve, 600));
    server = {
      ...server,
      health: {
        status: "ok",
        message: null,
        toolCount: 3,
        checkedAt: new Date().toISOString(),
      },
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: server }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expandAdvancedSection(page.getByTestId("integrations-advanced"));
  await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();

  // OAuth being connected must not read as "working": health is the primary status.
  const health = page.getByTestId("mcp-health");
  await expect(health).toHaveAttribute("data-status", "error");
  await expect(health).toContainText("Not working");
  await expect(page.getByText("OAuth connected", { exact: true })).toBeVisible();

  // The raw log hides behind a disclosure, rendered left-to-right and scrollable.
  const details = page.getByTestId("mcp-health-details");
  const detailsTrigger = details.getByRole("button", { name: "Error details" });
  await expect(detailsTrigger).toHaveAttribute("aria-expanded", "false");
  await detailsTrigger.click();
  await expect(detailsTrigger).toHaveAttribute("aria-expanded", "true");
  const log = details.locator("pre");
  await expect(log).toBeVisible();
  await expect(log).toHaveAttribute("dir", "ltr");
  await expect(log).toContainText("MCP error -32000: Connection closed");
  await captureScreenshot(page, testInfo, "mcp-health-error");

  // Test connection calls the RPC, shows a busy state, and swaps in the fresh health.
  const testButton = page.getByRole("button", { name: "Test connection", exact: true });
  await testButton.click();
  await expect(page.getByRole("button", { name: "Testing…", exact: true })).toBeDisabled();
  await expect(health).toHaveAttribute("data-status", "ok");
  await expect(health).toContainText("Running · 3 tools");
  await expect(page.getByTestId("mcp-health-details")).toHaveCount(0);
  await expect(page.getByText("Gmail is running")).toBeVisible();
  await expect(testButton).toBeEnabled();
  expect(testCalls).toBe(1);
  await captureScreenshot(page, testInfo, "mcp-health-ok");
});

test("polls the server list while a stdio package is installing", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `mcp-installing-${stamp}@rakazo.test`, "password12", "MCP installing");
  await completeOnboarding(page);

  let listCalls = 0;
  let installing = true;
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    listCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          stdioServer({
            health: installing
              ? { status: "installing", message: null, toolCount: null, checkedAt: null }
              : {
                  status: "ok",
                  message: null,
                  toolCount: 1,
                  checkedAt: new Date().toISOString(),
                },
          }),
        ],
      }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expandAdvancedSection(page.getByTestId("integrations-advanced"));
  await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();

  const health = page.getByTestId("mcp-health");
  await expect(health).toHaveAttribute("data-status", "installing");
  await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
  const beforePoll = listCalls;
  installing = false;
  await expect(health).toHaveAttribute("data-status", "ok", { timeout: 15_000 });
  expect(listCalls).toBeGreaterThan(beforePoll);
  await expect(health).toContainText("Running · 1 tool");

  // Polling stops once nothing is installing.
  const settled = listCalls;
  await page.waitForTimeout(3500);
  expect(listCalls).toBe(settled);
});
