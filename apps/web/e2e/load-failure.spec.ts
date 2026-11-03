import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a failed integrations load offers Retry instead of an empty catalog", async ({
  page,
}, testInfo) => {
  await signup(page, `catalog-load-${Date.now()}@rakazo.test`, "password12", "Catalog Load");
  await completeOnboarding(page);

  // A 502 is what the proxy answers while the API restarts.
  let failCatalog = true;
  await page.route("**/rpc/connections/catalog", async (route) => {
    if (failCatalog) {
      await route.fulfill({ status: 502 });
      return;
    }
    await route.fulfill({
      json: {
        json: [
          {
            connectorId: "demo",
            slug: "slack",
            name: "Slack",
            logo: null,
            connected: false,
            noAuth: false,
          },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();

  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Could not reach the server", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Configure a plugin catalog on the server to connect apps.", { exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-load-failed");

  failCatalog = false;
  await retry.click();
  // Add appears only on a tile backed by a loaded catalog entry.
  const slack = page
    .getByTestId("featured-connectors")
    .getByText("Slack", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await expect(slack.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByText("Could not reach the server", { exact: true })).toHaveCount(0);
  await expect(retry).toHaveCount(0);
});
