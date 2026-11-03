import { expect, test } from "@playwright/test";
import type {
  AgentSkillCatalogEntry,
  BotMcpServer,
  CapabilityInstall,
  McpServer,
} from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Integrations installs a plugin, completes real broker OAuth against a fake provider, and removes its children", async ({
  page,
}, testInfo) => {
  await signup(page, `marketplace-${Date.now()}@rakazo.test`, "password12", "Marketplace Test");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let cancel = true;
  await page.context().route("https://marketplace-auth.example.test/authorize**", async (route) => {
    const authorize = new URL(route.request().url());
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    if (cancel)
      return route.fulfill({ contentType: "text/html", body: "<h1>Fixture provider sign-in</h1>" });
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", authorize.searchParams.get("state")!);
    redirect.searchParams.set("code", "fake-marketplace-code");
    return route.fulfill({ status: 302, headers: { location: redirect.toString() } });
  });

  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Integrations", exact: true });
  const section = dialog.getByTestId("plugin-section").filter({ hasText: "Productivity" });
  await expect(section.getByText("Planning Notes", { exact: true })).toBeVisible();
  // A skill pack has nothing to connect, so it is offered under Skills instead.
  await expect(dialog.getByText("Review Kit", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-plugins");
  await dialog.getByRole("textbox", { name: "Search apps", exact: true }).fill("planning");
  const row = dialog.getByTestId("plugin-results").getByTestId("plugin-row");
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Planning Notes", exact: true })).toBeVisible();
  await expect(
    dialog.getByText("https://marketplace-tools.example.test/mcp", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/^Not added/)).toHaveCount(0);
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  await captureScreenshot(page, testInfo, "integrations-plugin-detail");

  // Connecting adds only the connector; the skills are a separate choice.
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const installs = await rpc<CapabilityInstall[]>(page, "capabilities/list", undefined);
  const install = installs.find((row) => row.kind === "plugin")!;
  expect(install.version).toBe("f".repeat(40));
  expect(install.config).toMatchObject({ parts: ["connector"] });
  const skillNames = async () =>
    (await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined)).map(
      (skill) => skill.name,
    );
  expect(await skillNames()).not.toContain("planning-notes");
  await dialog.getByRole("button", { name: "Add skills", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove skills", exact: true })).toBeVisible();
  expect(await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined)).toContainEqual(
    expect.objectContaining({ name: "planning-notes", source: "plugin", readOnly: true }),
  );
  const servers = await rpc<McpServer[]>(page, "mcp/servers/list", undefined);
  const server = servers.find((row) => row.installId === install.id)!;
  expect(server.oauthStatus).toBe("none");
  expect(await rpc(page, "mcp/assignments/list", { botId })).toEqual([]);

  // Closing the provider must not claim Connected or lose the install.
  const cancelledPopup = page.waitForEvent("popup", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  const first = await cancelledPopup;
  await expect(first.getByRole("heading", { name: "Fixture provider sign-in" })).toBeVisible();
  await first.close();
  await expect(dialog.getByRole("alert")).toContainText("Sign-in cancelled");
  await expect(dialog.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();

  cancel = false;
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  const popup = await popupPromise;
  await expect(dialog.getByRole("img", { name: "Connected", exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const connected = (await rpc<McpServer[]>(page, "mcp/servers/list", undefined)).find(
    (row) => row.id === server.id,
  )!;
  expect(connected).toMatchObject({ oauthStatus: "connected", hasSecret: true });
  expect(JSON.stringify(connected)).not.toContain("fake-marketplace-access");
  await dialog.getByRole("button", { name: "Use in this bot", exact: true }).click();
  await expect(dialog.getByText("In this bot", { exact: true })).toBeVisible();
  expect(await rpc<BotMcpServer[]>(page, "mcp/assignments/list", { botId })).toContainEqual(
    expect.objectContaining({ serverId: server.id }),
  );
  await captureScreenshot(page, testInfo, "integrations-plugin-connected");

  await dialog.getByRole("button", { name: "Close integrations", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await dialog.getByRole("button", { name: /^\d+ connected$/ }).click();
  const apps = dialog.getByTestId("connected-apps").getByTestId("installed-plugin");
  await expect(apps).toContainText("Planning Notes");
  await expect(apps).toContainText("1 connector");
  await expect(apps.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  // Skills are managed in the Skills dialog; the Connected view lists apps only.
  await expect(dialog.getByTestId("connected-skills")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-manage");

  // Removing the connector keeps the skills; removing the last part removes the plugin.
  await apps.getByRole("button", { name: /Planning Notes/ }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  expect(await rpc(page, "mcp/servers/list", undefined)).toEqual([]);
  expect(await rpc(page, "mcp/assignments/list", { botId })).toEqual([]);
  expect(await skillNames()).toContain("planning-notes");
  await dialog.getByRole("button", { name: "Remove skills", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add skills", exact: true })).toBeVisible();
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  expect(await skillNames()).not.toContain("planning-notes");
});
