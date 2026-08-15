import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { RakazoDesktop } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

describe("desktop preload bridge", () => {
  it("exposes only the platform and the four window operations", async () => {
    const invoke = vi.fn(async (channel: string) => ({ channel }));
    const exposeInMainWorld = vi.fn();
    const source = readFileSync(path.join(import.meta.dirname, "preload.cjs"), "utf8");

    vm.runInNewContext(source, {
      process: { platform: "linux" },
      require(moduleName: string) {
        if (moduleName !== "electron") throw new Error(`Unexpected preload import: ${moduleName}`);
        return { contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke } };
      },
    });

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
    expect(globalName).toBe("rakazoDesktop");
    expect(bridge.platform).toBe("linux");
    expect(Object.keys(bridge.window).sort()).toEqual([
      "close",
      "minimize",
      "state",
      "toggleMaximize",
    ]);

    await bridge.window.close();
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.state();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.window.close",
      "desktop.window.minimize",
      "desktop.window.toggleMaximize",
      "desktop.window.state",
    ]);
  });
});
