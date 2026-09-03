import { expect, type Route, test } from "@playwright/test";
import type { McpServer } from "@rakazo/contracts";
import { MCP_OAUTH_CHANNEL } from "../src/lib/mcp-connect";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("connects an MCP server through the OAuth popup callback", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-oauth-${stamp}@rakazo.test`, "password12", "MCP OAuth");
  await completeOnboarding(page);

  let oauthStatus: McpServer["oauthStatus"] = "none";
  let hasSecret = false;
  const server: McpServer = {
    id: "mcp-oauth-server",
    spaceId: "mcp-oauth-workspace",
    slug: "linear",
    name: "Linear MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.linear.test/mcp",
    command: null,
    args: [],
    envKeys: [],
    headerKeys: [],
    hasSecret,
    oauthStatus,
    enabled: true,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const browserOrigin = new URL(page.url()).origin;
  let releaseCompletion = () => {};
  let markCompletionStarted = () => {};
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const completionStarted = new Promise<void>((resolve) => {
    markCompletionStarted = resolve;
  });

  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [{ ...server, hasSecret, oauthStatus }] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });
  await page.context().route("**/rpc/mcp/oauth/begin", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        serverId: server.id,
        redirectUri: `${browserOrigin}/mcp/oauth/callback`,
      },
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          status: "authorization_required",
          sessionId: "mcp-oauth-session",
          authorizationUrl: `${browserOrigin}/mcp/oauth/callback?code=fake-code&state=mcp-oauth-session`,
        },
      }),
    });
  });
  await page.context().route("**/rpc/mcp/oauth/complete", async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        sessionId: "mcp-oauth-session",
        code: "fake-code",
        state: "mcp-oauth-session",
      },
    });
    markCompletionStarted();
    await completionGate;
    oauthStatus = "connected";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });

  await page.getByText("Integrations", { exact: true }).click();
  await page.getByTestId("integrations-advanced").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await page.getByRole("button", { name: "MCP servers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByText("Linear MCP", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access token (optional)")).toBeHidden();
  await captureScreenshot(page, testInfo, "mcp-oauth-ready");

  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Access token (optional)")).toBeVisible();
  await page.getByText("Advanced", { exact: true }).click();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect OAuth", exact: true }).click();
  const popup = await popupPromise;
  await completionStarted;
  await expect(popup.getByText("Finishing MCP connection…", { exact: true })).toBeVisible();
  await captureScreenshot(popup, testInfo, "mcp-oauth-callback");

  releaseCompletion();
  await expect(page.getByText("OAuth connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect OAuth", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await captureScreenshot(page, testInfo, "mcp-oauth-connected");

  oauthStatus = "reconnect";
  hasSecret = true;
  await page.evaluate((channelName) => {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "mcp-oauth-complete" });
    channel.close();
  }, MCP_OAUTH_CHANNEL);
  await expect(page.getByText("OAuth expired", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-oauth-expired");
});
