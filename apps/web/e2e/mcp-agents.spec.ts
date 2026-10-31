import { expect, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, rpc, signup } from "./helpers";

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
  const writer = await rpc<{ id: string }>(page, "bots/create", {
    name: "Writer",
    computerMode: "team",
  });
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
    const { json } = route.request().postDataJSON() as {
      json: { allBots: boolean; botIds: string[] };
    };
    requests.push(json);
    servers[0] = { ...server, allBots: json.allBots };
    const assignments = json.botIds.map((botId) => ({
      id: `assignment-${botId}`,
      botId,
      serverId: server.id,
      allowAllTools: true,
      allowedTools: [],
      createdAt: server.createdAt,
      updatedAt: server.createdAt,
    }));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { server: servers[0], assignments } }),
    });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await page.getByLabel("Server name").fill("Search Console");
  await page.getByLabel("Server URL").fill(server.endpoint!);
  await captureScreenshot(page, testInfo, "mcp-agents-add");
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const access = page.getByTestId("mcp-server").getByTestId("agent-access");
  await expect(access).toContainText("All agents");
  await captureScreenshot(page, testInfo, "mcp-agents");

  await access.getByRole("button").click();
  const chief = page.getByRole("menuitemcheckbox", { name: "Chief", exact: true });
  await expect(chief).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-agents-menu");
  await chief.click();
  await page.keyboard.press("Escape");
  await expect(access).toContainText("Writer");
  expect(requests).toEqual([{ id: server.id, allBots: false, botIds: [writer.id] }]);
});
