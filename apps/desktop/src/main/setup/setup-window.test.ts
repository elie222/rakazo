import { deferred } from "@rakazo/core/test-async";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { isSetupSaveInProgress, registerSetupIpc, showSetupWindow } from "./setup-window.js";

type Listener = (event: IpcCaller, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ invoke: new Map<string, Listener>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => mocks.invoke.set(channel, listener),
    on: vi.fn(),
  },
  app: { quit: vi.fn(), isPackaged: true },
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
const onAppReady = vi.fn();

beforeEach(() => {
  page = fakeWindow();
  opening = deferred<boolean>();
  settleLocalStack.mockReset().mockResolvedValue(undefined);
  onAppReady.mockReset();
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
    onAppReady,
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
    expect(onAppReady).not.toHaveBeenCalled();
    showSetupWindow("Could not reach the server.");
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("notifies onAppReady after saving a server and closing setup", async () => {
    const destroy = vi.fn(() => {
      desktop.setupWindow = null;
    });
    (page as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy = destroy;
    desktop.mainWindow = {
      ...fakeWindow(),
      webContents: { once: vi.fn(), removeListener: vi.fn(), isCrashed: () => false },
    } as unknown as BrowserWindow;
    desktop.currentTargetUrl = SERVER;
    const save = mocks.invoke.get("desktop.setup.save")?.(page.event, {
      mode: "existing",
      serverUrl: SERVER,
      headers: {},
    });
    expect(isSetupSaveInProgress()).toBe(true);
    opening.resolve(true);
    await expect(save).resolves.toEqual({ ok: true });
    expect(isSetupSaveInProgress()).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("defers onAppReady while setup save is in progress and fires it if setup closed before a failed save", async () => {
    let closedHandler: (() => void) | undefined;
    const main = {
      isDestroyed: () => false,
      hide: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        once: vi.fn(),
        removeListener: vi.fn(),
        isCrashed: () => false,
      },
    };
    desktop.mainWindow = main as unknown as BrowserWindow;
    desktop.currentTargetUrl = "https://previous.example";
    desktop.setupWindow = null;

    const createdSetup = {
      ...fakeWindow(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "closed") closedHandler = listener;
      }),
      destroy: vi.fn(() => {
        desktop.setupWindow = null;
        closedHandler?.();
      }),
      loadFile: vi.fn(() => Promise.resolve()),
      webContents: {
        mainFrame: {},
        setWindowOpenHandler: vi.fn(),
      },
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function mockWindow() {
      return createdSetup as unknown as BrowserWindow;
    });
    showSetupWindow();
    const setupEvent = {
      sender: createdSetup.webContents,
      senderFrame: createdSetup.webContents.mainFrame,
    } as unknown as IpcCaller;

    const save = mocks.invoke.get("desktop.setup.save")?.(setupEvent, {
      mode: "existing",
      serverUrl: SERVER,
      headers: {},
    });
    expect(isSetupSaveInProgress()).toBe(true);
    // Closing setup while save is still running must not fire onAppReady against the old server.
    closedHandler?.();
    expect(onAppReady).not.toHaveBeenCalled();

    // Save fails and leaves the restored main window visible with setup closed: now onAppReady runs.
    opening.resolve(false);
    await expect(save).resolves.toMatchObject({ ok: false });
    expect(isSetupSaveInProgress()).toBe(false);
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("does not fire onAppReady when a post-destroy renderer crash rolls back to setup", async () => {
    let closedHandler: (() => void) | undefined;
    let crashed = false;
    const main = {
      isDestroyed: () => false,
      hide: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        once: vi.fn(),
        removeListener: vi.fn(),
        isCrashed: () => crashed,
      },
    };
    desktop.mainWindow = main as unknown as BrowserWindow;
    desktop.currentTargetUrl = "https://previous.example";
    desktop.setupWindow = null;

    const createdSetup = {
      ...fakeWindow(),
      once: vi.fn((event: string, listener: () => void) => {
        if (event === "closed") closedHandler = listener;
      }),
      destroy: vi.fn(() => {
        desktop.setupWindow = null;
        closedHandler?.();
        crashed = true;
      }),
      loadFile: vi.fn(() => Promise.resolve()),
      webContents: {
        mainFrame: {},
        setWindowOpenHandler: vi.fn(),
      },
    };
    vi.mocked(BrowserWindow).mockImplementationOnce(function mockWindow() {
      return createdSetup as unknown as BrowserWindow;
    });
    registerSetupIpc({
      userDataDir: "unused",
      appOpener: { busy: () => false, open: () => opening.promise },
      probeServer: async () => ({ ok: true }),
      configureHeaderSession: vi.fn(),
      syncHostComputerAccess: vi.fn(),
      commitPendingAppSwitch: vi.fn(),
      abandonPendingAppSwitch: vi.fn(),
      recoverFromCrashedSave: async () => {
        desktop.setupWindow = createdSetup as unknown as BrowserWindow;
        return "Renderer stopped.";
      },
      stopStackLeftBehind: vi.fn(),
      settleLocalStack,
      onAppReady,
    } as unknown as Parameters<typeof registerSetupIpc>[0]);

    showSetupWindow();
    const setupEvent = {
      sender: createdSetup.webContents,
      senderFrame: createdSetup.webContents.mainFrame,
    } as unknown as IpcCaller;

    const save = mocks.invoke.get("desktop.setup.save")?.(setupEvent, {
      mode: "existing",
      serverUrl: SERVER,
      headers: {},
    });
    opening.resolve(true);
    await expect(save).resolves.toMatchObject({ ok: false });
    expect(onAppReady).not.toHaveBeenCalled();
  });
});
