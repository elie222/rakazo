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
    await expect(dialog.getByText("Docker gives bots a separate workspace.")).toBeVisible();
    const host = platform === "darwin" ? "this Mac" : "this computer";
    await expect(
      dialog.getByText(
        `On ${host}, bots can access your files and run commands without asking. Avoid this on shared or public servers.`,
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Docker (recommended)" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Use ${host}` })).toBeVisible();
    await captureScreenshot(page, testInfo, `host-computer-choice-${platform}`);
  });
}
