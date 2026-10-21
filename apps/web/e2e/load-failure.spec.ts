import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewSpace, signup } from "./helpers";

test("a failed overlay chunk keeps the shell and the draft, and Refresh loads it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `overlay-load-${stamp}@rakazo.test`, "password12", "Overlay Load");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Keep this draft");

  const pluginsChunk = /\/pages\/PluginsOverlay\.tsx/;
  await page.route(pluginsChunk, (route) => route.fulfill({ status: 404 }));
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();

  const failed = page.getByRole("alertdialog", { name: "Could not load" });
  await expect(failed).toBeVisible();
  await captureScreenshot(page, testInfo, "overlay-load-failed");

  await failed.getByRole("button", { name: "Close", exact: true }).click();
  await expect(failed).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft");

  await page.unroute(pluginsChunk);
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await failed.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
});

test("a failed page chunk shows Refresh instead of a blank app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `page-load-${stamp}@rakazo.test`, "password12", "Page Load");
  await completeOnboarding(page);

  const artifactsChunk = /\/pages\/Artifacts\.tsx/;
  await page.route(artifactsChunk, (route) => route.fulfill({ status: 404 }));
  await page.goto("/app/artifacts");

  await expect(page.getByText("Something went wrong. Try again.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-load-failed");

  await page.unroute(artifactsChunk);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await expect(page.getByText("Something went wrong. Try again.", { exact: true })).toHaveCount(0);
});

for (const [failing, intact] of [
  ["ScratchpadSection", "bot-knowledge"],
  ["KnowledgeSection", "bot-scratchpad"],
] as const) {
  test(`a failed ${failing} chunk keeps the rest of the bot settings panel`, async ({ page }) => {
    const stamp = Date.now();
    await signup(page, `section-load-${stamp}@rakazo.test`, "password12", "Section Load");
    await completeOnboarding(page);

    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("Keep this draft");

    await page.route(new RegExp(`/pages/${failing}\\.tsx`), (route) =>
      route.fulfill({ status: 404 }),
    );
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();

    const settings = page.getByTestId("bot-settings");
    await settings.getByText("Advanced", { exact: true }).click();
    await expect(settings.getByText("Could not load", { exact: true })).toBeVisible();
    await expect(settings.getByTestId(intact)).toBeVisible();
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Keep this draft");
  });
}

for (const overlay of ["settings", "integrations"] as const) {
  test(`preload recovery reopens ${overlay} once after an automatic reload`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `preload-${overlay}-${Date.now()}@rakazo.test`,
      "password12",
      "Preload Recovery",
    );
    await completeOnboarding(page);
    const chunk =
      overlay === "settings" ? /\/pages\/SettingsOverlay\.tsx/ : /\/pages\/PluginsOverlay\.tsx/;
    const opened =
      overlay === "settings"
        ? page.getByTestId("user-settings")
        : page.getByPlaceholder("Search apps");
    const originalUrl = page.url();
    await page.route(
      chunk,
      async (route) => {
        await route.fulfill({ status: 404 });
        await page
          .evaluate(() =>
            window.dispatchEvent(new Event("vite:preloadError", { cancelable: true })),
          )
          .catch(() => undefined);
      },
      { times: 1 },
    );
    const reloaded = page.waitForEvent("load");
    if (overlay === "settings") await page.getByTestId("user-menu-trigger").click();
    await page
      .getByRole("button", {
        name: overlay === "settings" ? "Settings" : "Connect apps",
        exact: true,
      })
      .click();
    await reloaded;
    await expect(opened).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
    await captureScreenshot(page, testInfo, `preload-recovered-${overlay}`);
    await page.reload();
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    await expect(opened).toHaveCount(0);
  });
}

test("preload recovery keeps Settings bound to another space", async ({ page }, testInfo) => {
  await signup(page, `preload-space-${Date.now()}@rakazo.test`, "password12", "Preload Recovery");
  await completeOnboarding(page);
  const personalUrl = page.url();
  await openNewSpace(page);
  const dialog = page.getByRole("dialog", { name: "New space" });
  await dialog.getByLabel("Name").fill("Support");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await completeOnboarding(page);
  await page.waitForURL((url) => url.pathname.startsWith("/app/") && url.href !== personalUrl);
  const originalUrl = page.url();
  const selected = await page.evaluate(() => localStorage.getItem("rakazo:space-id"));
  await page.route(
    /\/pages\/SettingsOverlay\.tsx/,
    async (route) => {
      await route.fulfill({ status: 404 });
      await page
        .evaluate(() => window.dispatchEvent(new Event("vite:preloadError", { cancelable: true })))
        .catch(() => undefined);
    },
    { times: 1 },
  );
  const reloaded = page.waitForEvent("load");
  await page.locator("aside").first().getByRole("button", { name: "Actions for Personal" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await reloaded;
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByTestId("settings-space")).toHaveText("Personal");
  await expect(page).toHaveURL(originalUrl);
  expect(await page.evaluate(() => localStorage.getItem("rakazo:space-id"))).toBe(selected);
  await captureScreenshot(page, testInfo, "preload-recovered-space-settings");
});

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
