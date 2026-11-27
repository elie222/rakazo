import { EventEmitter } from "node:events";
import type { App, BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import {
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
      isLoadingMainFrame: vi.fn(() => false),
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

describe("desktop deep-link events", () => {
  function listen(initialArgv: string[] = []) {
    const app = new EventEmitter() as EventEmitter & Pick<App, "on">;
    const isOpening = vi.fn(() => false);
    const reopen = vi.fn();
    const handlers = registerDeepLinkHandlers(app, { initialArgv, isOpening, reopen });
    return {
      ...handlers,
      isOpening,
      reopen,
      launch: (...argv: string[]) => app.emit("second-instance", {}, ["Rakazo", ...argv]),
      openUrl: (url: string) => {
        const preventDefault = vi.fn();
        app.emit("open-url", { preventDefault }, url);
        return preventDefault;
      },
    };
  }

  afterEach(() => {
    desktop.setupWindow = null;
    desktop.mainWindow = null;
    desktop.currentTargetUrl = null;
  });

  it("reuses the signed-in window for a second-instance launch", () => {
    const events = listen();
    events.finishStartup();
    const win = fakeWindow({ isMinimized: () => true });
    desktop.mainWindow = win;
    desktop.currentTargetUrl = "https://rakazo.example:8443";

    events.launch("rakazo://app/bot-99?m=abc");

    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://rakazo.example:8443/app/bot-99?m=abc",
    );
  });

  it("opens a cold-start argument once startup finishes", () => {
    const events = listen(["Rakazo", "rakazo://app/cold"]);
    const win = fakeWindow();
    desktop.mainWindow = win;
    desktop.currentTargetUrl = "https://rakazo.example";

    events.applyPending();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
    events.finishStartup();
    events.applyPending();
    expect(win.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://rakazo.example/app/cold",
    );
  });

  it("keeps the latest link while setup or a server switch is still in progress", () => {
    const events = listen();
    events.finishStartup();
    const win = fakeWindow();
    const setup = fakeWindow();
    desktop.mainWindow = win;
    desktop.setupWindow = setup;
    desktop.currentTargetUrl = "https://previous.example";

    events.launch("rakazo://app/first");
    expect(setup.focus).toHaveBeenCalledOnce();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();

    desktop.setupWindow = null;
    events.isOpening.mockReturnValue(true);
    events.launch("rakazo://app/latest");
    expect(win.webContents.loadURL).not.toHaveBeenCalled();

    desktop.currentTargetUrl = "https://rakazo.example";
    events.isOpening.mockReturnValue(false);
    events.applyPending();
    expect(win.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://rakazo.example/app/latest",
    );
  });

  it("waits for startup before reopening a closed app for a macOS URL", () => {
    const events = listen();
    expect(events.openUrl("rakazo://app/early")).toHaveBeenCalledOnce();
    expect(events.reopen).not.toHaveBeenCalled();
    events.finishStartup();

    events.openUrl("rakazo://app/reopen");
    expect(events.reopen).toHaveBeenCalledOnce();

    const win = fakeWindow();
    desktop.mainWindow = win;
    desktop.currentTargetUrl = "https://rakazo.example";
    events.applyPending();
    expect(win.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://rakazo.example/app/reopen",
    );
  });

  it("preserves duplicate-launch focus and ignores unsupported macOS URLs", () => {
    const events = listen();
    events.finishStartup();
    const win = fakeWindow();
    desktop.mainWindow = win;

    events.launch("--regular-launch");
    expect(events.openUrl("rakazo://billing")).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.webContents.loadURL).not.toHaveBeenCalled();
  });
});
