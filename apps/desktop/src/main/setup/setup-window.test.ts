import { deferred } from "@rakazo/core/test-async";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { registerSetupIpc, showSetupWindow } from "./setup-window.js";

type Listener = (event: IpcCaller, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ invoke: new Map<string, Listener>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => mocks.invoke.set(channel, listener),
    on: vi.fn(),
  },
  app: { quit: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1200, height: 800 } }) },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../system/monitoring.js", () => ({ reportDesktopError: vi.fn() }));
vi.mock("./setup-store.js", () => ({ writeSetup: vi.fn() }));

const SERVER = "https://rakazo.example";
const FAILURE = "Could not open that server. The server page did not become ready.";

function fakeWindow() {
  const frame = {};
  const webContents = { mainFrame: frame };
  return {
    isDestroyed: () => false,
    reload: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    webContents,
    event: { sender: webContents, senderFrame: frame } as unknown as IpcCaller,
  };
}

let page: ReturnType<typeof fakeWindow>;
let opening: ReturnType<typeof deferred<boolean>>;
const settleLocalStack = vi.fn<() => Promise<void>>();

beforeEach(() => {
  page = fakeWindow();
  opening = deferred<boolean>();
  settleLocalStack.mockReset().mockResolvedValue(undefined);
  desktop.setupWindow = page as unknown as BrowserWindow;
  desktop.mainWindow = null;
  desktop.setupError = null;
  desktop.currentSetup = null;
  registerSetupIpc({
    userDataDir: "unused",
    appOpener: { busy: () => false, open: () => opening.promise },
    probeServer: async () => ({ ok: true }),
    configureHeaderSession: vi.fn(),
    syncHostComputerAccess: vi.fn(),
    commitPendingAppSwitch: vi.fn(),
    abandonPendingAppSwitch: vi.fn(),
    recoverFromCrashedSave: vi.fn(),
    stopStackLeftBehind: vi.fn(),
    settleLocalStack,
  } as unknown as Parameters<typeof registerSetupIpc>[0]);
});
afterEach(() => {
  desktop.setupWindow = null;
  desktop.setupError = null;
});

it("checks the selected stack before saving a local connection", async () => {
  const previousStack = desktop.localStack;
  const selected = deferred<void>();
  const serverUrl = "http://127.0.0.1:47000";
  const matchesDesiredStack = vi.fn().mockResolvedValue(false);
  settleLocalStack.mockImplementation(async () => {
    await selected.promise;
    desktop.localStack = {
      webUrl: () => serverUrl,
      matchesDesiredStack,
      state: vi.fn(),
      managedStackRunning: () => false,
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
    };
  });

  try {
    const save = mocks.invoke.get("desktop.setup.save")?.(page.event, { mode: "new", serverUrl });
    expect(settleLocalStack).toHaveBeenCalledOnce();
    expect(matchesDesiredStack).not.toHaveBeenCalled();
    selected.resolve();
    await expect(save).resolves.toMatchObject({ ok: false });
    expect(matchesDesiredStack).toHaveBeenCalledOnce();
  } finally {
    desktop.localStack = previousStack;
  }
});

describe("showSetupWindow", () => {
  it("reloads the open setup page to show a launch failure", () => {
    showSetupWindow("Could not reach the server.");
    expect(page.reload).toHaveBeenCalledOnce();
    expect(desktop.setupError).toBe("Could not reach the server.");
  });

  it("keeps the page and answers its pending save when the server fails to open", async () => {
    const save = mocks.invoke.get("desktop.setup.save")?.(page.event, {
      mode: "existing",
      serverUrl: SERVER,
      headers: { "X-Gate": "one" },
    });
    // The opener reports the failure through the setup window while the save waits.
    showSetupWindow(FAILURE);
    opening.resolve(false);

    await expect(save).resolves.toEqual({ ok: false, error: FAILURE });
    expect(page.reload).not.toHaveBeenCalled();
    expect(desktop.setupError).toBeNull();
  });

  it("reloads again once the save has finished", async () => {
    const save = mocks.invoke.get("desktop.setup.save")?.(page.event, {
      mode: "existing",
      serverUrl: SERVER,
      headers: {},
    });
    opening.resolve(false);
    await save;
    showSetupWindow("Could not reach the server.");
    expect(page.reload).toHaveBeenCalledOnce();
  });
});
