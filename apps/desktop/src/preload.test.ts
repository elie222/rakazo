import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { RakazoDesktop } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

describe("desktop preload bridge", () => {
  it("exposes only the platform, the four window operations, and the updater", async () => {
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
    expect(Object.keys(bridge.update).sort()).toEqual(["check", "download", "install", "state"]);

    await bridge.window.close();
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.state();
    await bridge.update.state();
    await bridge.update.check();
    await bridge.update.download();
    await bridge.update.install();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.window.close",
      "desktop.window.minimize",
      "desktop.window.toggleMaximize",
      "desktop.window.state",
      "desktop.update.state",
      "desktop.update.check",
      "desktop.update.download",
      "desktop.update.install",
    ]);
  });

  it("keeps setup off the app bridge so a connected server cannot re-point the app", () => {
    const { exposeInMainWorld } = runPreload("preload.cjs");
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(bridge).sort()).toEqual(["platform", "update", "window"]);
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
    await bridge.save({ mode: "local", serverUrl: "http://127.0.0.1:5173" });
    await bridge.quit();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.setup.state",
      "desktop.setup.test",
      "desktop.setup.save",
      "desktop.setup.quit",
    ]);
  });
});
