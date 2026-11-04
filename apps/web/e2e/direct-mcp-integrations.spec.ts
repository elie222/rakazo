import { expect, test } from "@playwright/test";
import type { CapabilityInstall, McpServer } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openIntegrationsAdd, rpc, signup } from "./helpers";

test("shows directly registered MCP servers in Integrations without catalog connections", async ({
  page,
}, testInfo) => {
  await signup(page, `direct-mcp-list-${Date.now()}@rakazo.test`, "password12", "Direct MCP List");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await openIntegrationsAdd(page, "Manage MCP servers");
  await expect(page.getByRole("textbox", { name: "Server name", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close MCP servers", exact: true }).click();
  for (const name of ["Dropbox", "GitHub"])
    await rpc(page, "mcp/servers/create", {
      slug: name.toLowerCase(),
      name,
      transport: "streamable_http",
      endpoint: `https://${name.toLowerCase()}.example.test/mcp`,
      secret: "fake-mcp-credential",
    });
  expect(await rpc(page, "connections/list", undefined)).toEqual([]);
  // Every connection state, on the two real servers plus copies of one.
  // "partial": Docs has one connected and one failing server; "all": both connected;
  // "down": nothing is connected.
  let phase: "partial" | "all" | "down" = "partial";
  const states: Record<string, [string, (server: McpServer) => McpServer]> = {
    Dropbox: [
      "Connected",
      (s) => ({ ...s, health: { ...s.health, status: phase === "down" ? "error" : "ok" } }),
    ],
    GitHub: ["Needs sign-in", (s) => ({ ...s, oauthStatus: "reconnect" })],
    Linear: ["Not connected", (s) => ({ ...s, health: { ...s.health, status: "unknown" } })],
    Notion: ["Not working", (s) => ({ ...s, health: { ...s.health, status: "error" } })],
    Figma: [
      "Needs an OAuth client ID",
      (s) => ({ ...s, health: { ...s.health, status: "error", code: MCP_OAUTH_CLIENT_REQUIRED } }),
    ],
    Slack: ["Disabled", (s) => ({ ...s, enabled: false })],
  };
  await page.route("**/rpc/mcp/servers/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: McpServer[] };
    const [first] = body.json;
    const copies = Object.keys(states)
      .filter((name) => !body.json.some((server) => server.name === name))
      .map((name) => ({ ...first!, id: `copy-${name}`, slug: name.toLowerCase(), name }));
    const json = [...body.json, ...copies].map((server) => states[server.name]![1](server));
    // Plugin servers: Notes is signed in but failing, Docs has two, and Empty has none.
    const pluginServer = (install: string, slug: string, working: boolean) => ({
      ...first!,
      id: `copy-${slug}`,
      slug,
      name: `${install}: ${slug}`,
      installId: `install-${install}`,
      oauthStatus: "connected" as const,
      health: { ...first!.health, status: working ? ("ok" as const) : ("error" as const) },
    });
    const plugins = [
      pluginServer("notes", "notes-mcp", false),
      pluginServer("docs", "docs-read", phase !== "down"),
      pluginServer("docs", "docs-write", phase === "all"),
    ];
    await route.fulfill({ response, json: { ...body, json: [...json, ...plugins] } });
  });
  await page.route("**/rpc/capabilities/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: CapabilityInstall[] };
    const plugins = ["notes", "docs", "empty"].map(
      (name): CapabilityInstall => ({
        id: `install-${name}`,
        kind: "plugin",
        name: name.charAt(0).toUpperCase() + name.slice(1),
        source: `https://plugins.example.test/${name}`,
        version: null,
        digest: null,
        secretConfigured: false,
        config: { parts: ["connector"] },
        createdAt: new Date().toISOString(),
      }),
    );
    await route.fulfill({ response, json: { ...body, json: [...body.json, ...plugins] } });
  });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  // Of six saved servers and three plugins, only Dropbox is connected: Docs has a failing
  // server. The plugin rows show once installs have loaded, so the count is read after that.
  await page.getByRole("button", { name: /^\d+ connected$/ }).click();
  await expect(page.getByTestId("installed-plugin")).toHaveCount(3);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // The count's logos are decorative (aria-hidden); a plugin shows one only once it counts.
  const marks = (count: string) =>
    page.getByRole("button", { name: count, exact: true }).locator("span[aria-hidden]").first();
  await expect(marks("1 connected")).toHaveText("");
  await page.getByRole("button", { name: "1 connected", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  const servers = page.getByTestId("registered-mcp-servers");
  await expect(servers.getByText("Dropbox", { exact: true })).toBeVisible();
  await expect(servers.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(servers.getByTestId("registered-mcp-server")).toHaveCount(6);
  for (const [name, [label]] of Object.entries(states)) {
    const server = servers.getByTestId("registered-mcp-server").filter({
      has: page.getByText(name, { exact: true }),
    });
    await expect(server.getByText(label, { exact: true })).toBeVisible();
    await expect(server.getByText(name.charAt(0), { exact: true })).toBeVisible();
    await expect(server.getByRole("button")).toHaveCount(0);
  }
  await expect(servers).not.toContainText("fake-mcp-credential");
  await captureScreenshot(page, testInfo, "integrations-direct-mcp-servers");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "integrations-direct-mcp-mobile");
  await page
    .getByTestId("connected-apps")
    .getByRole("button", { name: "Manage MCP servers", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("GitHub", { exact: true })).toBeVisible();

  // Once both of its servers are connected, Docs counts once.
  phase = "all";
  await page.getByRole("button", { name: "Close MCP servers", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByRole("button", { name: "2 connected", exact: true })).toBeVisible();
  await expect(marks("2 connected")).toHaveText("D");
  await page.getByRole("button", { name: "Close integrations", exact: true }).click();

  // With nothing connected, the count still opens the saved apps.
  phase = "down";
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(marks("0 connected")).toHaveText("");
  await page.getByRole("button", { name: "0 connected", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your apps", exact: true })).toBeVisible();
  await expect(servers.getByTestId("registered-mcp-server")).toHaveCount(6);
  await expect(
    servers.getByTestId("registered-mcp-server").filter({ hasText: "Dropbox" }),
  ).toContainText("Not working");
  await page.unrouteAll({ behavior: "wait" });
});
