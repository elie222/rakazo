import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import {
  createDeepLinkController,
  handleSecondInstance,
  registerDeepLinkHandlers,
  revealSecondInstanceWindow,
  secondInstanceWindow,
} from "./second-instance.js";

function fakeWindow(overrides: Partial<BrowserWindow> = {}, currentUrl = "https://rakazo.example") {
  const loadURL = vi.fn(() => Promise.resolve());
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      getURL: vi.fn(() => currentUrl),
      loadURL,
    },
    ...overrides,
  } as unknown as BrowserWindow & {
    webContents: { getURL: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn> };
  };
}

describe("second-instance window", () => {
  it("raises the setup window while onboarding is still open", () => {
    const setup = fakeWindow();
    const main = fakeWindow();
    expect(secondInstanceWindow(setup, main)).toBe(setup);
  });

  it("falls back to the main window once setup closed", () => {
    const setup = fakeWindow({ isDestroyed: () => true });
    const main = fakeWindow();
    expect(secondInstanceWindow(setup, main)).toBe(main);
    expect(secondInstanceWindow(null, main)).toBe(main);
  });

  it("returns nothing when every window is gone", () => {
    expect(secondInstanceWindow(null, null)).toBeNull();
    expect(secondInstanceWindow(null, fakeWindow({ isDestroyed: () => true }))).toBeNull();
  });

  it("restores a minimized window before showing and focusing it", () => {
    const win = fakeWindow({ isMinimized: () => true });
    revealSecondInstanceWindow(win);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("skips restore on a normal window", () => {
    const win = fakeWindow();
    revealSecondInstanceWindow(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });
});

describe("handleSecondInstance", () => {
  it("focuses the main window without navigating when no deep link is present", () => {
    const main = fakeWindow();
    const onRevealMainWindow = vi.fn();
    const result = handleSecondInstance({
      argv: ["Rakazo.exe"],
      setupWindow: null,
      mainWindow: main,
      currentTargetUrl: "https://rakazo.example",
      onRevealMainWindow,
    });
    expect(result).toEqual({ kind: "focused" });
    expect(onRevealMainWindow).toHaveBeenCalledOnce();
    expect(main.focus).toHaveBeenCalledOnce();
    expect(main.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("focuses and navigates the main window for a valid deep link on a configured server", () => {
    const main = fakeWindow({ isMinimized: () => true });
    const result = handleSecondInstance({
      argv: ["Rakazo.exe", "rakazo://app/bot-99?m=abc"],
      setupWindow: null,
      mainWindow: main,
      currentTargetUrl: "https://rakazo.example:8443",
    });
    expect(result).toEqual({ kind: "navigated" });
    expect(main.restore).toHaveBeenCalledOnce();
    expect(main.show).toHaveBeenCalledOnce();
    expect(main.focus).toHaveBeenCalledOnce();
    expect(main.webContents.loadURL).toHaveBeenCalledWith(
      "https://rakazo.example:8443/app/bot-99?m=abc",
    );
  });

  it("focuses without navigating when the deep link is invalid or disallowed", () => {
    const main = fakeWindow();
    const result = handleSecondInstance({
      argv: ["Rakazo.exe", "rakazo://billing"],
      setupWindow: null,
      mainWindow: main,
      currentTargetUrl: "https://rakazo.example",
    });
    expect(result).toEqual({ kind: "focused" });
    expect(main.focus).toHaveBeenCalledOnce();
    expect(main.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("focuses the setup window and queues the deep link without bypassing setup", () => {
    const setup = fakeWindow();
    const main = fakeWindow();
    const result = handleSecondInstance({
      argv: ["Rakazo.exe", "rakazo://app/bot-99"],
      setupWindow: setup,
      mainWindow: main,
      currentTargetUrl: "https://rakazo.example",
    });
    expect(result).toEqual({
      kind: "queued",
      deepLink: { kind: "bot", botId: "bot-99", search: "", hash: "" },
    });
    expect(setup.focus).toHaveBeenCalledOnce();
    expect(main.focus).not.toHaveBeenCalled();
    expect(main.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("queues a valid deep link when the main window or server is not ready yet", () => {
    const result = handleSecondInstance({
      argv: ["Rakazo.exe", "rakazo://app/bot-99"],
      setupWindow: null,
      mainWindow: null,
      currentTargetUrl: null,
    });
    expect(result).toEqual({
      kind: "queued",
      deepLink: { kind: "bot", botId: "bot-99", search: "", hash: "" },
    });
  });
});

describe("createDeepLinkController", () => {
  it("applies a cold-start argv deep link once the app window is ready and clears it", () => {
    let setupWindow: BrowserWindow | null = fakeWindow();
    let mainWindow: ReturnType<typeof fakeWindow> | null = null;
    let currentTargetUrl: string | null = null;

    const controller = createDeepLinkController({
      initialArgv: ["Rakazo.exe", "rakazo://app/bot-cold"],
      setupWindow: () => setupWindow,
      mainWindow: () => mainWindow,
      currentTargetUrl: () => currentTargetUrl,
      onRevealMainWindow: vi.fn(),
      reopenIfClosed: vi.fn(),
    });

    // Does not navigate while setup is open or main is not ready.
    controller.applyPending();

    mainWindow = fakeWindow();
    currentTargetUrl = "https://rakazo.example";
    controller.applyPending();
    expect(mainWindow.webContents.loadURL).not.toHaveBeenCalled();

    // Once setup closes, applies exactly once and clears.
    setupWindow = null;
    controller.applyPending();
    expect(mainWindow.webContents.loadURL).toHaveBeenCalledOnce();
    expect(mainWindow.webContents.loadURL).toHaveBeenCalledWith(
      "https://rakazo.example/app/bot-cold",
    );

    mainWindow.webContents.loadURL.mockClear();
    controller.applyPending();
    expect(mainWindow.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("handles open-url by ignoring invalid links and reopening when the main window is closed", () => {
    let mainWindow: ReturnType<typeof fakeWindow> | null = null;
    const reopenIfClosed = vi.fn();

    const controller = createDeepLinkController({
      initialArgv: ["Rakazo"],
      setupWindow: () => null,
      mainWindow: () => mainWindow,
      currentTargetUrl: () => "https://rakazo.example",
      onRevealMainWindow: vi.fn(),
      reopenIfClosed,
    });

    controller.handleOpenUrl("rakazo://billing");
    expect(reopenIfClosed).not.toHaveBeenCalled();

    controller.handleOpenUrl("rakazo://app/bot-mac");
    expect(reopenIfClosed).toHaveBeenCalledOnce();

    mainWindow = fakeWindow();
    controller.applyPending();
    expect(mainWindow.webContents.loadURL).toHaveBeenCalledWith(
      "https://rakazo.example/app/bot-mac",
    );
  });

  it("queues a deep link while appOpener is still loading the main window", () => {
    let opening = true;
    const main = fakeWindow();

    const controller = createDeepLinkController({
      initialArgv: ["Rakazo"],
      setupWindow: () => null,
      mainWindow: () => main,
      currentTargetUrl: () => "https://rakazo.example",
      isOpening: () => opening,
      onRevealMainWindow: vi.fn(),
      reopenIfClosed: vi.fn(),
    });

    expect(controller.handleArgv(["Rakazo", "rakazo://app/bot-reopen"])).toEqual({
      kind: "queued",
      deepLink: { kind: "bot", botId: "bot-reopen", search: "", hash: "" },
    });
    expect(main.webContents.loadURL).not.toHaveBeenCalled();

    // Still loading: applyPending keeps the link queued.
    controller.applyPending();
    expect(main.webContents.loadURL).not.toHaveBeenCalled();

    // Once opening completes, applyPending navigates once.
    opening = false;
    controller.applyPending();
    expect(main.webContents.loadURL).toHaveBeenCalledOnce();
    expect(main.webContents.loadURL).toHaveBeenCalledWith("https://rakazo.example/app/bot-reopen");
  });
});

describe("registerDeepLinkHandlers", () => {
  it("registers the rakazo protocol only for packaged builds", () => {
    const packagedApp = {
      isPackaged: true,
      isReady: () => true,
      on: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(),
    };
    registerDeepLinkHandlers(packagedApp as never, {
      initialArgv: ["Rakazo.exe"],
      isOpening: () => false,
      reopenTarget: vi.fn(),
    }).registerProtocol();
    expect(packagedApp.setAsDefaultProtocolClient).toHaveBeenCalledWith("rakazo");

    const devApp = {
      isPackaged: false,
      isReady: () => true,
      on: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(),
    };
    registerDeepLinkHandlers(devApp as never, {
      initialArgv: ["electron", "."],
      isOpening: () => false,
      reopenTarget: vi.fn(),
    }).registerProtocol();
    expect(devApp.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  afterEach(() => {
    desktop.setupWindow = null;
    desktop.mainWindow = null;
    desktop.currentTargetUrl = null;
  });

  it("opens setup when open-url arrives with all windows closed and no server configured", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      isPackaged: true,
      isReady: () => true,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      setAsDefaultProtocolClient: vi.fn(),
    };
    const reopenTarget = vi.fn();
    const showSetup = vi.fn();
    desktop.setupWindow = null;
    desktop.mainWindow = null;
    desktop.currentTargetUrl = null;

    registerDeepLinkHandlers(electronApp as never, {
      initialArgv: ["Rakazo"],
      isOpening: () => false,
      reopenTarget,
      showSetup,
    });

    const preventDefault = vi.fn();
    listeners.get("open-url")?.({ preventDefault }, "rakazo://app/bot-unconfigured");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(showSetup).toHaveBeenCalledOnce();
    expect(reopenTarget).not.toHaveBeenCalled();
  });
});
