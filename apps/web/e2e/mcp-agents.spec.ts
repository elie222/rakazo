import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, signup } from "./helpers";

const server: McpServer = {
  id: "mcp-agents-server",
  spaceId: "mcp-agents-workspace",
  slug: "search-console",
  name: "Search Console",
  description: "",
  transport: "streamable_http",
  endpoint: "https://mcp.search-console.test/mcp",
  command: null,
  hasArgs: false,
  envKeys: [],
  fileKeys: [],
  headerKeys: [],
  hasSecret: false,
  oauthStatus: "none",
  oauthClientId: null,
  health: { status: "ok", message: null, toolCount: 7, checkedAt: "2026-10-30T00:00:00.000Z" },
  enabled: true,
  revision: 1,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};

test("a connected MCP server shows which agents can use it", async ({ page }, testInfo) => {
  await signup(page, `mcp-agents-${Date.now()}@rakazo.test`, "password12", "MCP agents");
  await completeOnboarding(page);
  await page.context().route("**/rpc/mcp/servers/list", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [server] }) }),
  );

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await expect(page.getByText("Search Console", { exact: true })).toBeVisible();
  await page.getByLabel("Server name").fill("Analytics");
  await captureScreenshot(page, testInfo, "mcp-agents");
});
