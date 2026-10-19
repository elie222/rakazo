import { expect, test } from "@playwright/test";
import type {
  AgentSkillCatalogEntry,
  BotMcpServer,
  CapabilityInstall,
  McpServer,
} from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("marketplace installs a plugin, completes real broker OAuth against a fake provider, and removes its children", async ({
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

  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Marketplace", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search plugins", exact: true }).fill("planning");
  const tile = dialog.getByRole("button", { name: /planning-notes/ });
  await expect(tile).toBeVisible();
  await captureScreenshot(page, testInfo, "marketplace-search");
  await tile.click();
  await expect(dialog.getByRole("heading", { name: "planning-notes", exact: true })).toBeVisible();
  await expect(
    dialog.getByText("https://marketplace-tools.example.test/mcp", { exact: true }),
  ).toBeVisible();
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  await dialog.getByText("Skipped components", { exact: false }).click();
  await expect(dialog.getByText("rules/", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "marketplace-preview");
  await dialog.getByRole("button", { name: "Add plugin", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const installs = await rpc<CapabilityInstall[]>(page, "capabilities/list", undefined);
  const install = installs.find((row) => row.kind === "plugin")!;
  expect(install.version).toBe("f".repeat(40));
  const skills = await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined);
  expect(skills).toContainEqual(
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
  await expect(dialog.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const connected = (await rpc<McpServer[]>(page, "mcp/servers/list", undefined)).find(
    (row) => row.id === server.id,
  )!;
  expect(connected).toMatchObject({ oauthStatus: "connected", hasSecret: true });
  expect(JSON.stringify(connected)).not.toContain("fake-marketplace-access");
  await dialog.getByRole("button", { name: "Use in this bot", exact: true }).click();
  await expect(dialog.getByText("Enabled for this bot", { exact: true })).toBeVisible();
  expect(await rpc<BotMcpServer[]>(page, "mcp/assignments/list", { botId })).toContainEqual(
    expect.objectContaining({ serverId: server.id }),
  );
  await captureScreenshot(page, testInfo, "marketplace-connected");

  await dialog.getByRole("button", { name: "Close marketplace", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Marketplace", exact: true }).click();
  await dialog.getByRole("button", { name: "Installed", exact: true }).click();
  await dialog.getByRole("button", { name: /planning-notes/ }).click();
  await expect(dialog.getByText("Connected", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove plugin", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(dialog.getByText("No plugins installed", { exact: true })).toBeVisible();
  expect(await rpc(page, "mcp/servers/list", undefined)).toEqual([]);
  expect(await rpc(page, "mcp/assignments/list", { botId })).toEqual([]);
  expect(
    (await rpc<AgentSkillCatalogEntry[]>(page, "agentSkills/list", undefined)).some(
      (row) => row.name === "planning-notes",
    ),
  ).toBe(false);
});

test("marketplace links open the browser and manual Git import still requires confirmation", async ({
  page,
}) => {
  await signup(
    page,
    `marketplace-link-${Date.now()}@rakazo.test`,
    "password12",
    "Marketplace Link Test",
  );
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?marketplace=1");
  const dialog = page.getByRole("dialog", { name: "Marketplace", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByText("Install from GitHub", { exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Plugin GitHub URL", exact: true })
    .fill("https://github.com/example/plugin-marketplace-fixture");
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add plugin", exact: true })).toBeVisible();
  expect(await rpc(page, "capabilities/list", undefined)).toEqual([]);
  await page.goto("/app?marketplace=installed");
  await expect(dialog.getByText("No plugins installed", { exact: true })).toBeVisible();
});
