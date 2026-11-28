import type { DesktopLocalStackState } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import { applicationMenuInstaller } from "./app-menu.js";

const mocks = vi.hoisted(() => ({
  template: [] as Electron.MenuItemConstructorOptions[],
  quit: vi.fn(),
  showSetupWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { name: "Rakazo", quit: mocks.quit },
  dialog: { showMessageBox: vi.fn() },
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      mocks.template = template;
      return template;
    },
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock("../setup/setup-window.js", () => ({
  showSetupWindow: mocks.showSetupWindow,
}));

vi.mock("../system/monitoring.js", () => ({
  reportDesktopError: vi.fn(),
}));

vi.mock("./app-window.js", () => ({
  remoteServerOrigin: () => null,
}));

function findMenuItem(id: string): Electron.MenuItemConstructorOptions | undefined {
  for (const menu of mocks.template) {
    const submenu = Array.isArray(menu.submenu) ? menu.submenu : [];
    const match = submenu.find((item) => item.id === id);
    if (match) return match;
  }
  return undefined;
}

describe("applicationMenuInstaller quit and stop bots", () => {
  const previousSetup = desktop.currentSetup;
  const previousHostComputer = desktop.hostComputer;
  const previousLocalStack = desktop.localStack;

  beforeEach(() => {
    mocks.template = [];
    mocks.quit.mockReset();
    mocks.showSetupWindow.mockReset();
    desktop.currentSetup = { mode: "new", serverUrl: "http://127.0.0.1:45173" };
  });

  afterEach(() => {
    desktop.currentSetup = previousSetup;
    desktop.hostComputer = previousHostComputer;
    desktop.localStack = previousLocalStack;
  });

  it("restores host computer access via syncHostComputerAccess when stopping fails", async () => {
    const activate = vi.fn();
    let enabled = true;
    activate.mockImplementation((value: boolean) => {
      enabled = value;
    });
    const failedState: DesktopLocalStackState = {
      phase: "failed",
      failedOperation: "stop",
      message: "Could not stop the local stack. Check that Docker is running, then try again.",
      output: [],
      layerBytes: {},
      layerTotals: {},
      imageTag: "v1.0.0",
    };
    desktop.hostComputer = {
      isEnabled: () => enabled,
      activate,
    } as unknown as typeof desktop.hostComputer;
    desktop.localStack = {
      managedStackRunning: () => true,
      stop: vi.fn(async () => failedState),
    } as unknown as typeof desktop.localStack;

    const syncHostComputerAccess = vi.fn(() => {
      desktop.hostComputer?.activate(desktop.currentSetup?.mode === "new");
    });
    const install = applicationMenuInstaller({
      revokeLocalComputerAccess: vi.fn(async () => undefined),
      syncHostComputerAccess,
      updaterEnvironment: { packaged: false, version: "1.0.0" },
    });
    install();

    const item = findMenuItem("quit-and-stop-bots");
    expect(item?.visible).toBe(true);
    item!.click?.(undefined as never, undefined as never, undefined as never);
    await flush();

    expect(activate).toHaveBeenNthCalledWith(1, false);
    expect(syncHostComputerAccess).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenLastCalledWith(true);
    expect(mocks.showSetupWindow).toHaveBeenCalledWith(failedState.message, {
      quitAfterStop: true,
    });
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("restores host computer access when stopping rejects", async () => {
    const activate = vi.fn();
    desktop.hostComputer = {
      isEnabled: () => true,
      activate,
    } as unknown as typeof desktop.hostComputer;
    desktop.localStack = {
      managedStackRunning: () => true,
      state: () => ({
        phase: "failed" as const,
        failedOperation: "stop" as const,
        message: "Could not stop the local stack. Check that Docker is running, then try again.",
        output: [],
        layerBytes: {},
        layerTotals: {},
        imageTag: "v1.0.0",
      }),
      stop: vi.fn(async () => {
        throw new Error("docker disappeared");
      }),
    } as unknown as typeof desktop.localStack;

    const syncHostComputerAccess = vi.fn(() => {
      desktop.hostComputer?.activate(desktop.currentSetup?.mode === "new");
    });
    const install = applicationMenuInstaller({
      revokeLocalComputerAccess: vi.fn(async () => undefined),
      syncHostComputerAccess,
      updaterEnvironment: { packaged: false, version: "1.0.0" },
    });
    install();

    findMenuItem("quit-and-stop-bots")!.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    await flush();

    expect(activate).toHaveBeenNthCalledWith(1, false);
    expect(syncHostComputerAccess).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenLastCalledWith(true);
    expect(mocks.showSetupWindow).toHaveBeenCalledWith(
      "Could not stop the local stack. Check that Docker is running, then try again.",
      { quitAfterStop: true },
    );
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("quits without re-enabling host computer access when stopping succeeds", async () => {
    const activate = vi.fn();
    desktop.hostComputer = {
      isEnabled: () => true,
      activate,
    } as unknown as typeof desktop.hostComputer;
    desktop.localStack = {
      managedStackRunning: () => true,
      stop: vi.fn(async () => ({
        phase: "idle",
        message: null,
        output: [],
        layerBytes: {},
        layerTotals: {},
        imageTag: "v1.0.0",
      })),
    } as unknown as typeof desktop.localStack;

    const syncHostComputerAccess = vi.fn();
    const install = applicationMenuInstaller({
      revokeLocalComputerAccess: vi.fn(async () => undefined),
      syncHostComputerAccess,
      updaterEnvironment: { packaged: false, version: "1.0.0" },
    });
    install();

    findMenuItem("quit-and-stop-bots")!.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    await flush();

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(false);
    expect(syncHostComputerAccess).not.toHaveBeenCalled();
    expect(mocks.showSetupWindow).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
