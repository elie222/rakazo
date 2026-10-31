import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { RakazoDesktop, RakazoSetup } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

function runPreload(
  file: string,
  ipc: { invoke?: unknown; on?: unknown; off?: unknown } = {},
  platform = "linux",
) {
  const invoke =
    (ipc.invoke as ReturnType<typeof vi.fn>) ?? vi.fn(async (channel: string) => ({ channel }));
  const on = (ipc.on as ReturnType<typeof vi.fn>) ?? vi.fn();
  const off = (ipc.off as ReturnType<typeof vi.fn>) ?? vi.fn();
  const exposeInMainWorld = vi.fn();
  const source = readFileSync(path.join(import.meta.dirname, file), "utf8");

  vm.runInNewContext(source, {
    process: { platform },
    require(moduleName: string) {
      if (moduleName !== "electron") throw new Error(`Unexpected preload import: ${moduleName}`);
      return { contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, on, off } };
    },
  });

  return { invoke, on, off, exposeInMainWorld };
}

describe("desktop preload bridge", () => {
  it.each(["win32", "darwin", "linux"])(
    "advertises native framing only on Windows (%s)",
    (platform) => {
      const { exposeInMainWorld } = runPreload("preload.cjs", {}, platform);
      const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
      expect(bridge.nativeWindowFrame).toBe(platform === "win32");
    },
  );

  it("exposes the scoped desktop bridges", async () => {
    const { invoke, exposeInMainWorld } = runPreload("preload.cjs");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
    expect(globalName).toBe("rakazoDesktop");
    expect(bridge.platform).toBe("linux");
    expect(Object.keys(bridge).sort()).toEqual([
      "badge",
      "computer",
      "device",
      "monitoring",
      "nativeWindowFrame",
      "oauth",
      "passkeys",
      "platform",
      "settings",
      "update",
      "window",
    ]);
    expect(Object.keys(bridge.window).sort()).toEqual([
      "close",
      "minimize",
      "state",
      "toggleMaximize",
    ]);
    expect(Object.keys(bridge.update).sort()).toEqual(["check", "download", "install", "state"]);

    expect(Object.keys(bridge.badge!)).toEqual(["set"]);
    await bridge.badge!.set(7);
    expect(invoke).toHaveBeenCalledWith("desktop.badge.set", 7);

    await bridge.device?.state();
    await bridge.device?.setAllowed(true);
    expect(invoke).toHaveBeenCalledWith("desktop.device.setAllowed", true);
    await bridge.oauth.open?.("https://provider.example.com/authorize");
    await bridge.oauth.cancel?.("https://provider.example.com/authorize");
    await bridge.monitoring?.enabled();
    await bridge.passkeys?.rpIds();
    await bridge.window.close();
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.state();
    await bridge.update.state();
    await bridge.update.check();
    await bridge.update.download();
    await bridge.update.install();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.badge.set",
      "desktop.device.state",
      "desktop.device.setAllowed",
      "desktop.oauth.open",
      "desktop.oauth.cancel",
      "desktop.monitoring.enabled",
      "desktop.passkeys.rpIds",
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

  it("forwards captured codes without leaking the IPC event to the renderer", () => {
    const listeners: Array<(event: unknown, callback: unknown) => void> = [];
    const on = vi.fn((_channel: string, handler: (event: unknown, callback: unknown) => void) => {
      listeners.push(handler);
    });
    const off = vi.fn();
    const { exposeInMainWorld } = runPreload("preload.cjs", { on, off });

    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
    const received: unknown[] = [];
    const unsubscribe = bridge.oauth.onCallback((callback) => received.push(callback));

    expect(on).toHaveBeenCalledWith("desktop.oauth.callback", expect.any(Function));
    listeners[0]?.({ sender: "ipc-event" }, { code: "ac_123", state: "verifier_456" });
    expect(received).toEqual([{ code: "ac_123", state: "verifier_456" }]);

    unsubscribe();
    expect(off).toHaveBeenCalledWith("desktop.oauth.callback", expect.any(Function));
  });

  it("opens settings from the menu signal without leaking the IPC event", () => {
    const listeners: Array<() => void> = [];
    const on = vi.fn((_channel: string, handler: () => void) => {
      listeners.push(handler);
    });
    const off = vi.fn();
    const { exposeInMainWorld } = runPreload("preload.cjs", { on, off });
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];

    const opened: string[] = [];
    const unsubscribe = bridge.settings!.onOpen(() => opened.push("settings"));

    expect(on).toHaveBeenCalledWith("desktop.settings.open", expect.any(Function));
    listeners[0]?.();
    expect(opened).toEqual(["settings"]);

    unsubscribe();
    expect(off).toHaveBeenCalledWith("desktop.settings.open", expect.any(Function));
  });

  it.each(["win32", "linux"])("offers system speech only on macOS (%s)", (platform) => {
    const { exposeInMainWorld } = runPreload("preload.cjs", {}, platform);
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
    expect(bridge.speech).toBeUndefined();
  });

  it("bridges macOS system speech without leaking the IPC event", async () => {
    const listeners: Array<(event: unknown, payload: unknown) => void> = [];
    const on = vi.fn((_channel: string, handler: (event: unknown, payload: unknown) => void) => {
      listeners.push(handler);
    });
    const off = vi.fn();
    const { invoke, exposeInMainWorld } = runPreload("preload.cjs", { on, off }, "darwin");
    const [, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoDesktop];
    const speech = bridge.speech!;

    await speech.start("es-CL", 3);
    await speech.stop(3);
    await speech.abort(3);
    expect(invoke.mock.calls).toEqual([
      ["desktop.speech.start", "es-CL", 3],
      ["desktop.speech.stop", 3],
      ["desktop.speech.abort", 3],
    ]);

    const received: unknown[] = [];
    const unsubscribe = speech.onEvent((event) => received.push(event));
    expect(on).toHaveBeenCalledWith("desktop.speech.event", expect.any(Function));
    listeners[0]?.({ sender: "ipc-event" }, { session: 3, type: "end" });
    expect(received).toEqual([{ session: 3, type: "end" }]);
    unsubscribe();
    expect(off).toHaveBeenCalledWith("desktop.speech.event", expect.any(Function));
  });
});

describe("setup preload bridge", () => {
  it("exposes only the first-run setup operations", async () => {
    const { invoke, on, exposeInMainWorld } = runPreload("setup-preload.cjs");

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [globalName, bridge] = exposeInMainWorld.mock.calls[0] as [string, RakazoSetup];
    expect(globalName).toBe("rakazoSetup");
    expect(bridge.platform).toBe("linux");
    expect(Object.keys(bridge).sort()).toEqual([
      "openLink",
      "platform",
      "quit",
      "save",
      "stack",
      "state",
      "test",
    ]);
    expect(Object.keys(bridge.stack).sort()).toEqual(["onChange", "start", "state"]);

    await bridge.state();
    await bridge.test("http://127.0.0.1:5173");
    await bridge.save({ mode: "new", serverUrl: "http://127.0.0.1:5173" });
    await bridge.quit();
    await bridge.openLink("orbstack");
    await bridge.stack.state();
    await bridge.stack.start();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "desktop.setup.state",
      "desktop.setup.test",
      "desktop.setup.save",
      "desktop.setup.quit",
      "desktop.setup.openLink",
      "desktop.setup.stack.state",
      "desktop.setup.stack.start",
    ]);
    expect(invoke).toHaveBeenCalledWith("desktop.setup.openLink", "orbstack");

    const listener = vi.fn();
    bridge.stack.onChange(listener);
    const [channel, handler] = on.mock.calls.at(-1) as [string, (...args: unknown[]) => void];
    expect(channel).toBe("desktop.setup.stack.changed");
    handler({}, { phase: "pulling" });
    expect(listener).toHaveBeenCalledWith({ phase: "pulling" });
  });
});
