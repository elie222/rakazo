import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { RakazoDesktop, RakazoSetup } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

function runPreload(file: string) {
  const invoke = vi.fn(async (channel: string) => ({ channel }));
  const exposeInMainWorld = vi.fn();
  const source = readFileSync(path.join(import.meta.dirname, file), "utf8");

  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(moduleName: string) {
      if (moduleName !== "electron") throw new Error(`Unexpected preload import: ${moduleName}`);
      return { contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke } };
    },
  });

  return { invoke, exposeInMainWorld };
}

describe("desktop preload bridge", () => {
  it("exposes only the platform and the four window operations", async () => {
    const { invoke, exposeInMainWorld } = runPreload("preload.cjs");

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

  it("keeps setup off the app bridge so a connected server cannot re-point the app", () => {
    const { exposeInMainWorld } = runPreload("preload.cjs");
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(bridge).sort()).toEqual(["platform", "window"]);
  });
});

describe("setup preload bridge", () => {
  it("exposes only the first-run setup operations", async () => {
    const { invoke, exposeInMainWorld } = runPreload("setup-preload.cjs");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoSetup];
    expect(globalName).toBe("rakazoSetup");
    expect(Object.keys(bridge).sort()).toEqual(["quit", "save", "state", "test"]);

    await bridge.state();
    await bridge.test("http://127.0.0.1:5173");
    await bridge.save({ mode: "new", serverUrl: "http://127.0.0.1:5173" });
    await bridge.quit();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.setup.state",
      "desktop.setup.test",
      "desktop.setup.save",
      "desktop.setup.quit",
    ]);
  });
});
