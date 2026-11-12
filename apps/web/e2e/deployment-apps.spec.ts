import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("bundled apps disclose missing setup and open account authorization without client credentials", async ({
  page,
}, testInfo) => {
  await signup(page, `app-connect-${Date.now()}@rakazo.test`, "password12", "App connection");
  await completeOnboarding(page);
  const app = { id: "files", name: "Files" };
  let needsSetup = true;
  let connected = false;
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "deployment",
            slug: app.id,
            name: app.name,
            logo: null,
            connected,
            noAuth: false,
            mcpAppId: app.id,
            needsSetup,
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await page.getByPlaceholder("Search apps").fill(app.name);
  await expect(page.getByText("Server setup required", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "deployment-app-needs-setup");

  needsSetup = false;
  await page.reload();
  await page.getByPlaceholder("Search apps").fill(app.name);
  const row = page.getByText(app.name, { exact: true }).locator("xpath=ancestor::*[.//button][1]");
  await expect(row.getByRole("button", { name: "Connect Files", exact: true })).toBeVisible();
  await expect(page.getByLabel("Client secret", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "deployment-app-connect");
  await page.route("**/rpc/mcp/apps/connect", (route) =>
    route.fulfill({ json: { json: { serverId: "test-server" } } }),
  );
  await page.route("**/rpc/mcp/oauth/begin", (route) =>
    route.fulfill({
      json: {
        json: {
          status: "authorization_required",
          authorizationUrl: new URL("/mcp/oauth/callback?error=access_denied", page.url()).href,
        },
      },
    }),
  );
  const popupPromise = page.waitForEvent("popup");
  await row.getByRole("button", { name: "Connect Files", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/mcp\/oauth\/callback/);
  await popup.close();

  connected = true;
  needsSetup = true;
  await page.reload();
  await page.getByPlaceholder("Search apps").fill(app.name);
  await expect(row.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await expect(page.getByText("Server setup required", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "deployment-app-connected");
});

test("bundled app titles keep matching plugin skills reachable", async ({ page }, testInfo) => {
  await signup(page, `app-skills-${Date.now()}@rakazo.test`, "password12", "App skills");
  await completeOnboarding(page);
  // Reuse the existing marketplace fixture so this exercises the real plugin preview.
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "deployment",
            slug: "planning-notes",
            name: "Planning Notes",
            logo: null,
            connected: false,
            noAuth: false,
            mcpAppId: "notes",
          },
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await page.getByPlaceholder("Search apps").fill("Planning Notes");
  await expect(
    page.getByRole("button", { name: "Connect Planning Notes", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Planning Notes", { exact: true }) })
    .click();
  await expect(page.getByRole("heading", { name: "Planning Notes", exact: true })).toBeVisible();
  await expect(page.getByText("planning-notes", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "deployment-app-skills");
});
