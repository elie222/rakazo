import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers/helpers";

// Exercise the shared client with synthetic catalog/connection DTOs; no remote authorization or billing.
test("connects and removes a configured creative app through the existing catalog", async ({
  page,
}, testInfo) => {
  let connected = false;
  const account = {
    id: "demo-creative-account",
    connectorId: "creative",
    provider: "creative",
    displayName: "CreativeOne",
    status: "connected",
    capabilities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await page.route("**/rpc/connections/catalog", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            connectorId: "creative",
            slug: "creative",
            name: "CreativeOne",
            logo: null,
            connected,
            noAuth: false,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/connections/list", (route) =>
    route.fulfill({ json: { json: connected ? [account] : [] } }),
  );
  await page.route("**/rpc/connections/begin", async (route) => {
    expect(route.request().postDataJSON().json).toMatchObject({
      connectorId: "creative",
      provider: "creative",
    });
    connected = true;
    await route.fulfill({ json: { json: { connectionId: account.id, authorizationUrl: null } } });
  });
  await page.route("**/rpc/connections/complete", (route) =>
    route.fulfill({ json: { json: account } }),
  );
  await page.route("**/rpc/connections/tools", (route) =>
    route.fulfill({
      json: {
        json: [
          { name: "View models", description: "Read available models" },
          { name: "Create media", description: "Submit a creation" },
          { name: "Check progress", description: "Read a creation's status" },
        ],
      },
    }),
  );
  await page.route("**/rpc/connections/revoke", async (route) => {
    connected = false;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await signup(page, `creative-app-${Date.now()}@rakazo.test`, "password12", "Demo User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await page.getByRole("textbox", { name: "Search apps", exact: true }).fill("CreativeOne");
  await expect(page.getByText("CreativeOne", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "creative-app-catalog");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Added", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail.getByRole("textbox", { name: "Account label" })).toHaveValue("CreativeOne");
  await detail.getByText("3 tools", { exact: true }).click();
  for (const name of ["View models", "Create media", "Check progress"])
    await expect(detail.getByText(name, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "creative-app-connected");
  await detail.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(detail.getByRole("textbox", { name: "Account label" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
});
