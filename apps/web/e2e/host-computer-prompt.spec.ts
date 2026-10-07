import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

for (const platform of ["darwin", "win32"]) {
  test(`host computer choice explains file access on ${platform}`, async ({ page }, testInfo) => {
    await signup(
      page,
      `host-choice-${platform}-${Date.now()}@rakazo.test`,
      "password12",
      "Host Tester",
    );
    await completeOnboarding(page);
    await page.addInitScript((platform) => {
      Object.defineProperty(window, "rakazoDesktop", {
        value: {
          platform,
          window: {
            close: async () => {},
            minimize: async () => {},
            toggleMaximize: async () => {},
            state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
          },
          oauth: { onCallback: () => () => {} },
          update: {
            state: async () => ({ phase: "idle", currentVersion: "0.1.0" }),
          },
        },
      });
    }, platform);
    await page.route(/\/rpc\/(me|bootstrap)$/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const me = route.request().url().endsWith("/me") ? body.json : body.json.me;
      me.canChooseHostComputer = true;
      me.computerHost = null;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "Where should bots run?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      /Local access lets bots run commands without asking\. Avoid it on shared or public servers\./,
    );
    const host = platform === "darwin" ? "this Mac" : "this computer";
    await expect(
      dialog.getByText(
        `Docker limits access to your computer for added security. Using ${host} lets bots work with your local files and tools.`,
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Local access lets bots run commands without asking. Avoid it on shared or public servers.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Docker", exact: true })).toBeVisible();
    await expect(dialog.getByText(/recommended/i)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: `Use ${host}` })).toBeVisible();
    await captureScreenshot(page, testInfo, `host-computer-choice-${platform}`);
  });
}

test("a saved host choice closes when refreshing the profile fails", async ({ page }) => {
  await signup(page, `host-choice-refresh-${Date.now()}@rakazo.test`, "password12", "Host Tester");
  await completeOnboarding(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => ({ phase: "idle", currentVersion: "0.1.0" }),
        },
      },
    });
  });
  let failMe = false;
  await page.route(/\/rpc\/(me|bootstrap|deployment\/update)$/, async (route) => {
    const url = route.request().url();
    if (url.endsWith("/deployment/update")) {
      failMe = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            ownerUserId: null,
            signupsEnabled: true,
            signupAllowlist: [],
            hasDeploymentModelCredential: false,
            defaultProvider: null,
            defaultModel: null,
            computerHost: "docker",
            canChooseHostComputer: false,
            sandboxProvider: "fake",
          },
        }),
      });
      return;
    }
    if (url.endsWith("/me") && failMe) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          json: {
            defined: false,
            code: "INTERNAL_SERVER_ERROR",
            status: 500,
            message: "profile unavailable",
          },
        }),
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const me = url.endsWith("/me") ? body.json : body.json.me;
    me.canChooseHostComputer = true;
    me.computerHost = null;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "Where should bots run?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Docker", exact: true }).click();
  await expect(dialog).toBeHidden();
});
