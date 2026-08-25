import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { RakazoDesktop } from "@rakazo/contracts";

const fixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rakazo desktop smoke</title></head>
  <body><main>Desktop fixture ready</main></body>
</html>`;

test("launches with a narrow preload bridge and an isolated renderer", async () => {
  const app = await electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      RAKAZO_WEB_URL: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`,
    },
  });

  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Desktop fixture ready")).toBeVisible();
    await expect(page).toHaveTitle("Rakazo desktop smoke");

    const renderer = await page.evaluate(async () => {
      const desktop = (window as typeof window & { rakazoDesktop?: RakazoDesktop }).rakazoDesktop;

      return {
        bridgeKeys: desktop ? Object.keys(desktop).sort() : [],
        windowKeys: desktop ? Object.keys(desktop.window).sort() : [],
        updateKeys: desktop ? Object.keys(desktop.update).sort() : [],
        platform: desktop?.platform,
        state: await desktop?.window.state(),
        update: await desktop?.update.state(),
        nodeGlobals: {
          require: typeof (window as unknown as { require?: unknown }).require,
          process: typeof (window as unknown as { process?: unknown }).process,
          module: typeof (window as unknown as { module?: unknown }).module,
        },
      };
    });

    expect(renderer.bridgeKeys).toEqual(["oauth", "platform", "update", "window"]);
    expect(renderer.windowKeys).toEqual(["close", "minimize", "state", "toggleMaximize"]);
    expect(renderer.updateKeys).toEqual(["check", "download", "install", "state"]);
    expect(renderer.platform).toBe(process.platform);
    expect(renderer.state).toEqual({ minimized: false, maximized: false, fullScreen: false });
    // An unpackaged run has no update feed, and that is reported as a state rather than an error.
    expect(renderer.update).toMatchObject({ phase: "unsupported", availableVersion: null });
    expect(renderer.nodeGlobals).toEqual({
      require: "undefined",
      process: "undefined",
      module: "undefined",
    });

    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        count: BrowserWindow.getAllWindows().length,
        nodeIntegration: win?.webContents.getLastWebPreferences().nodeIntegration,
        contextIsolation: win?.webContents.getLastWebPreferences().contextIsolation,
        sandbox: win?.webContents.getLastWebPreferences().sandbox,
        state: {
          minimized: win?.isMinimized(),
          maximized: win?.isMaximized(),
          fullScreen: win?.isFullScreen(),
        },
      };
    });

    expect(preferences).toEqual({
      count: 1,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      state: renderer.state,
    });
  } finally {
    await app.close();
  }
});
