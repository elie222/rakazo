import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appWindowTargets, desktop } from "./desktop-state.js";
import type { IpcCaller } from "./ipc.js";
import { reportDesktopError } from "./monitoring.js";
import { registerWindowControls } from "./window-controls.js";

type Listener = (event: IpcCaller, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  invoke: new Map<string, Listener>(),
  windows: new Map<unknown, unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => mocks.invoke.set(channel, listener),
  },
  BrowserWindow: { fromWebContents: (contents: unknown) => mocks.windows.get(contents) ?? null },
}));
vi.mock("./monitoring.js", () => ({ reportDesktopError: vi.fn() }));

const NOTHING_DONE = { minimized: false, maximized: false, fullScreen: false };
const CONTROLS = ["close", "minimize", "toggleMaximize", "state"] as const;
const ACTIONS = ["close", "minimize", "maximize", "unmaximize", "setFullScreen"] as const;

function appWindow(origin: string) {
  const frame = { url: `${origin}/app/bot` };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const state = { minimized: false, maximized: false, fullScreen: false };
  const win = {
    webContents: contents,
    isDestroyed: () => false,
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    setFullScreen: vi.fn(),
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
  };
  mocks.windows.set(contents, win);
  appWindowTargets.set(win as unknown as BrowserWindow, origin);
  return { win, frame, state, event: { sender: contents, senderFrame: frame } as IpcCaller };
}
type AppWindow = ReturnType<typeof appWindow>;

const asWindow = (page: AppWindow) => page.win as unknown as BrowserWindow;
const call = (control: (typeof CONTROLS)[number], event: IpcCaller) =>
  mocks.invoke.get(`desktop.window.${control}`)?.(event);
const acted = (page: AppWindow) => ACTIONS.filter((action) => page.win[action].mock.calls.length);

/** A switch to another server, as far as the next window taking the app window's place. */
function switching() {
  const previous = appWindow("https://app.example.com");
  const next = appWindow("https://next.example.com");
  desktop.mainWindow = asWindow(next);
  desktop.replacedAppWindow = asWindow(previous);
  return { previous, next };
}

// Each test starts an hour on, so no test's reports are held back by an earlier one's.
let clock = Date.now();
beforeEach(() => {
  clock += 60 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  mocks.invoke.clear();
  mocks.windows.clear();
  vi.mocked(reportDesktopError).mockClear();
  desktop.mainWindow = null;
  desktop.replacedAppWindow = null;
  desktop.setupWindow = null;
  registerWindowControls();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("window controls", () => {
  it("act on the app window for its own page", () => {
    const app = appWindow("https://app.example.com");
    desktop.mainWindow = asWindow(app);

    call("close", app.event);
    call("minimize", app.event);
    call("toggleMaximize", app.event);
    expect(acted(app)).toEqual(["close", "minimize", "maximize"]);

    app.state.maximized = true;
    expect(call("state", app.event)).toEqual({ ...NOTHING_DONE, maximized: true });
    call("toggleMaximize", app.event);
    expect(app.win.unmaximize).toHaveBeenCalledTimes(1);
    expect(app.win.setFullScreen).toHaveBeenCalledWith(false);
  });

  describe("while a server switch keeps the window it replaces", () => {
    it("act on that window for its own page, and never on the window replacing it", () => {
      const { previous, next } = switching();
      previous.state.minimized = true;
      next.state.maximized = true;

      expect(call("state", previous.event)).toEqual({ ...NOTHING_DONE, minimized: true });
      call("close", previous.event);
      call("minimize", previous.event);
      call("toggleMaximize", previous.event);
      expect(acted(previous)).toEqual(["close", "minimize", "maximize"]);
      expect(acted(next)).toEqual([]);
      expect(reportDesktopError).not.toHaveBeenCalled();
    });

    it("act on the next window for its own page", () => {
      const { previous, next } = switching();
      next.state.maximized = true;

      expect(call("state", next.event)).toEqual({ ...NOTHING_DONE, maximized: true });
      call("close", next.event);
      call("minimize", next.event);
      expect(acted(next)).toEqual(["close", "minimize"]);
      expect(acted(previous)).toEqual([]);
    });

    it.each([
      "its subframe",
      "its frame that is gone",
      "its page on another origin",
      "another window showing the same page",
    ] as const)("do nothing for %s", (who) => {
      const { previous, next } = switching();
      previous.state.maximized = true;
      const callers: Record<typeof who, () => { event: IpcCaller; page: AppWindow }> = {
        "its subframe": () => ({
          event: { ...previous.event, senderFrame: { ...previous.frame } } as never,
          page: previous,
        }),
        "its frame that is gone": () => ({
          event: { ...previous.event, senderFrame: null },
          page: previous,
        }),
        "its page on another origin": () => {
          previous.frame.url = "https://other.example.com/app/bot";
          return { event: previous.event, page: previous };
        },
        "another window showing the same page": () => {
          const other = appWindow("https://app.example.com");
          other.state.maximized = true;
          return { event: other.event, page: other };
        },
      };
      const { event, page } = callers[who]();

      for (const control of CONTROLS) {
        expect(call(control, event), control).toEqual(
          control === "state" ? NOTHING_DONE : undefined,
        );
      }
      expect(acted(page)).toEqual([]);
      expect(acted(previous)).toEqual([]);
      expect(acted(next)).toEqual([]);
      expect(reportDesktopError).toHaveBeenCalledTimes(CONTROLS.length);
    });

    it("do nothing for that page once the switch is committed", () => {
      const { previous, next } = switching();
      previous.state.maximized = true;
      desktop.replacedAppWindow = null;

      for (const control of CONTROLS) {
        expect(call(control, previous.event), control).toEqual(
          control === "state" ? NOTHING_DONE : undefined,
        );
      }
      expect(acted(previous)).toEqual([]);
      expect(acted(next)).toEqual([]);
      expect(reportDesktopError).toHaveBeenCalledTimes(CONTROLS.length);
    });

    it("act on that window again once the switch is abandoned, and not for the window that failed", () => {
      const { previous, next } = switching();
      desktop.mainWindow = asWindow(previous);
      desktop.replacedAppWindow = null;

      call("minimize", previous.event);
      call("minimize", next.event);
      expect(acted(previous)).toEqual(["minimize"]);
      expect(acted(next)).toEqual([]);
    });
  });
});
