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
const recoverFromCrashedSave = vi.fn<() => Promise<string>>();

beforeEach(() => {
  page = fakeWindow();
  opening = deferred<boolean>();
  settleLocalStack.mockReset().mockResolvedValue(undefined);
  onAppReady.mockReset();
  recoverFromCrashedSave.mockReset();
  desktop.setupWindow = page as unknown as BrowserWindow;
  desktop.mainWindow = null;
  desktop.setupError = null;
  desktop.currentSetup = null;
  desktop.currentTargetUrl = null;
  registerSetupIpc({
    userDataDir: "unused",
    appOpener: { busy: () => false, open: () => opening.promise },
    probeServer: async () => ({ ok: true }),
    configureHeaderSession: vi.fn(),
    syncHostComputerAccess: vi.fn(),
    commitPendingAppSwitch: vi.fn(),
    abandonPendingAppSwitch: vi.fn(),
    recoverFromCrashedSave,
    stopStackLeftBehind: vi.fn(),
    settleLocalStack,
    onAppReady,
  } as unknown as Parameters<typeof registerSetupIpc>[0]);
});
afterEach(() => {
  desktop.setupWindow = null;
  desktop.setupError = null;
  desktop.mainWindow = null;
  desktop.currentTargetUrl = null;
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
});

describe("app readiness after setup", () => {
  function openSetup({ crashOnClose = false } = {}) {
    let closed: (() => void) | undefined;
    let crashed = false;
    desktop.mainWindow = {
      ...fakeWindow(),
      webContents: { once: vi.fn(), removeListener: vi.fn(), isCrashed: () => crashed },
    } as unknown as BrowserWindow;
    desktop.currentTargetUrl = SERVER;
    desktop.setupWindow = null;
    const setup = Object.assign(fakeWindow(), {
      once: (_event: "closed", listener: () => void) => {
        closed = listener;
      },
      destroy: () => {
        closed?.();
        crashed = crashOnClose;
      },
      loadFile: vi.fn().mockResolvedValue(undefined),
    });
    Object.assign(setup.webContents, { setWindowOpenHandler: vi.fn() });
    vi.mocked(BrowserWindow).mockImplementationOnce(function mockWindow() {
      return setup as unknown as BrowserWindow;
    });
    showSetupWindow();
    return {
      setup,
      close: setup.destroy,
      save: () =>
        mocks.invoke.get("desktop.setup.save")?.(setup.event, {
          mode: "existing",
          serverUrl: SERVER,
          headers: {},
        }),
    };
  }

  it("notifies after saving the server and closing setup", async () => {
    const { save } = openSetup();
    const result = save();
    expect(isSetupSaveInProgress()).toBe(true);
    opening.resolve(true);
    await expect(result).resolves.toEqual({ ok: true });
    expect(onAppReady).toHaveBeenCalledOnce();
    expect(desktop.setupWindow).toBeNull();
    expect(isSetupSaveInProgress()).toBe(false);
  });

  it("waits for a failed save before notifying when setup closed during the save", async () => {
    const { save, close } = openSetup();
    const result = save();
    close();
    expect(onAppReady).not.toHaveBeenCalled();

    opening.resolve(false);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(onAppReady).toHaveBeenCalledOnce();
  });

  it("does not notify when a renderer crash after setup closes reopens setup", async () => {
    const { setup, save } = openSetup({ crashOnClose: true });
    recoverFromCrashedSave.mockImplementation(async () => {
      desktop.setupWindow = setup as unknown as BrowserWindow;
      return "Renderer stopped.";
    });
    const result = save();
    opening.resolve(true);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(onAppReady).not.toHaveBeenCalled();
  });
});
