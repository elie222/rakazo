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
  allBots: true,
  revision: 1,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};

test("a server the user adds reaches every agent until they pick some", async ({
  page,
}, testInfo) => {
  await signup(page, `mcp-agents-${Date.now()}@rakazo.test`, "password12", "MCP agents");
  await completeOnboarding(page);
  const servers: McpServer[] = [];
  await page
    .context()
    .route("**/rpc/mcp/servers/list", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: servers }) }),
    );
  await page.context().route("**/rpc/mcp/servers/create", async (route) => {
    servers.push(server);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: server }),
    });
  });
  const requests: unknown[] = [];
  await page.context().route("**/rpc/mcp/servers/agents", async (route) => {
    const { json } = route.request().postDataJSON() as { json: { allBots: boolean } };
    requests.push(json);
    servers[0] = { ...server, allBots: json.allBots };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { server: servers[0], assignments: [] } }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await page.getByLabel("Server name").fill("Search Console");
  await page.getByLabel("Server URL").fill(server.endpoint!);
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const all = page.getByRole("button", { name: "All", exact: true });
  const chief = page.getByRole("button", { name: "Chief", exact: true });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(chief).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "mcp-agents");

  await chief.click();
  await expect(all).toHaveAttribute("aria-pressed", "false");
  await expect(chief).toHaveAttribute("aria-pressed", "false");
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  expect(requests).toEqual([
    { id: server.id, allBots: false, botIds: [] },
    { id: server.id, allBots: true, botIds: [] },
  ]);
});
