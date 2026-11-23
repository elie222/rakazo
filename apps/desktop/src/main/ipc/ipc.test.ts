import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { DesktopUpdateState, RakazoDesktop } from "@rakazo/contracts";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appWindowTargets, desktop } from "../desktop-state.js";
import { reportDesktopError } from "../system/monitoring.js";
import type { IpcCaller } from "./ipc.js";
import { handleIpc, sentFrom } from "./ipc.js";
import type { IpcChannel, IpcChannelName } from "./ipc-channels.js";
import { ipcChannels, LIVE, REJECTS } from "./ipc-channels.js";

type Listener = (event: IpcCaller & { returnValue?: unknown }, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  invoke: new Map<string, Listener>(),
  sync: new Map<string, Listener>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => mocks.invoke.set(channel, listener),
    on: (channel: string, listener: Listener) => mocks.sync.set(channel, listener),
  },
}));
vi.mock("../system/monitoring.js", () => ({ reportDesktopError: vi.fn() }));

const APP_URL = "https://app.example.com";

function fakeWindow(url: string) {
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  return { win, frame, event: { sender: contents, senderFrame: frame } as IpcCaller };
}

function open() {
  const app = fakeWindow(`${APP_URL}/app/bot`);
  const setup = fakeWindow("file:///resources/dist/setup.html");
  desktop.mainWindow = app.win;
  desktop.setupWindow = setup.win;
  appWindowTargets.set(app.win, APP_URL);
  return { app, setup };
}

/** Calls nobody may answer, for a window that is otherwise the right one. */
function strangers(page: ReturnType<typeof fakeWindow>): [string, IpcCaller][] {
  return [
    ["another window", fakeWindow(page.frame.url).event],
    ["a subframe", { ...page.event, senderFrame: { ...page.frame } } as IpcCaller],
    ["a frame that is gone", { ...page.event, senderFrame: null }],
  ];
}

/** The app page's bridge, as its preload builds it, for a page whose calls arrive as `caller`. */
function appBridge(caller: IpcCaller): RakazoDesktop {
  let bridge: RakazoDesktop | undefined;
  vm.runInNewContext(
    readFileSync(path.join(import.meta.dirname, "../../preload/preload.cjs"), "utf8"),
    {
      process: { platform: "darwin" },
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (_name: string, value: RakazoDesktop) => (bridge = value),
        },
        // Electron rejects the page's promise when the handler throws.
        ipcRenderer: {
          invoke: async (channel: string, ...args: unknown[]) =>
            mocks.invoke.get(channel)?.(caller, ...args),
          on: () => undefined,
          off: () => undefined,
        },
      }),
    },
  );
  return bridge!;
}

const names = Object.keys(ipcChannels) as IpcChannelName[];
const LIVE_ANSWER = { phase: "idle" };

/** Registers any channel the way its registration must: a `LIVE` one with its refused answer. */
function register(name: IpcChannelName, handler: (...args: never[]) => unknown) {
  const untyped = handleIpc as (
    name: IpcChannelName,
    handler: unknown,
    whenRefused?: () => unknown,
  ) => void;
  if (ipcChannels[name].refused === LIVE) untyped(name, handler, () => LIVE_ANSWER);
  else untyped(name, handler);
}

/** Another server is opening: its window is the app window, and the one it replaces is kept. */
function switchServer(previous: ReturnType<typeof fakeWindow>) {
  const next = fakeWindow("https://next.example.com/app");
  desktop.mainWindow = next.win;
  appWindowTargets.set(next.win, "https://next.example.com");
  desktop.replacedAppWindow = previous.win;
  return next;
}

// Each test starts an hour on, so no test's reports are held back by an earlier one's.
let clock = Date.now();
beforeEach(() => {
  clock += 60 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  mocks.invoke.clear();
  mocks.sync.clear();
  vi.mocked(reportDesktopError).mockClear();
  desktop.mainWindow = null;
  desktop.replacedAppWindow = null;
  desktop.setupWindow = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sentFrom", () => {
  it("accepts each window's own page and never the other window's", () => {
    const { app, setup } = open();
    expect(sentFrom("app", app.event)).toBe(true);
    expect(sentFrom("setup", setup.event)).toBe(true);
    expect(sentFrom("app", setup.event)).toBe(false);
    expect(sentFrom("setup", app.event)).toBe(false);
  });

  it("refuses other windows, subframes and missing frames", () => {
    const { app, setup } = open();
    for (const [, event] of strangers(app)) expect(sentFrom("app", event)).toBe(false);
    for (const [, event] of strangers(setup)) expect(sentFrom("setup", event)).toBe(false);
  });

  it.each(["https://other.example.com/app/bot", "data:text/html,page", "file:///page", "invalid"])(
    "refuses the app window while it shows %s",
    (url) => {
      const { app } = open();
      app.frame.url = url;
      expect(sentFrom("app", app.event)).toBe(false);
    },
  );

  it("accepts the window a switch is replacing only where the channel says so", () => {
    const { app: previous, setup } = open();
    expect(sentFrom("appOrReplaced", previous.event)).toBe(true);
    expect(sentFrom("appOrReplaced", setup.event)).toBe(false);

    const next = switchServer(previous);
    expect(sentFrom("appOrReplaced", previous.event)).toBe(true);
    expect(sentFrom("appOrReplaced", next.event)).toBe(true);
    expect(sentFrom("app", previous.event)).toBe(false);
    expect(sentFrom("setup", previous.event)).toBe(false);
    for (const [, event] of strangers(previous))
      expect(sentFrom("appOrReplaced", event)).toBe(false);
    expect(sentFrom("appOrReplaced", setup.event)).toBe(false);
    previous.frame.url = "https://other.example.com/app/bot";
    expect(sentFrom("appOrReplaced", previous.event)).toBe(false);
    previous.frame.url = `${APP_URL}/app/bot`;

    desktop.replacedAppWindow = Object.assign(previous.win, { isDestroyed: () => true });
    expect(sentFrom("appOrReplaced", previous.event)).toBe(false);
    Object.assign(previous.win, { isDestroyed: () => false });
    desktop.replacedAppWindow = null;
    expect(sentFrom("appOrReplaced", previous.event)).toBe(false);
  });

  it("refuses a window that is closed, replaced or was opened for no server", () => {
    const { app, setup } = open();
    appWindowTargets.delete(app.win);
    expect(sentFrom("app", app.event)).toBe(false);
    appWindowTargets.set(app.win, "data:text/html,page");
    app.frame.url = "data:text/html,page";
    expect(sentFrom("app", app.event)).toBe(false);

    appWindowTargets.set(app.win, APP_URL);
    app.frame.url = `${APP_URL}/app/bot`;
    desktop.mainWindow = fakeWindow(APP_URL).win;
    expect(sentFrom("app", app.event)).toBe(false);
    desktop.mainWindow = Object.assign(app.win, { isDestroyed: () => true });
    expect(sentFrom("app", app.event)).toBe(false);

    desktop.setupWindow = Object.assign(setup.win, { isDestroyed: () => true });
    expect(sentFrom("setup", setup.event)).toBe(false);
    desktop.setupWindow = null;
    expect(sentFrom("setup", setup.event)).toBe(false);
  });
});

describe("handleIpc", () => {
  it("answers the window the channel belongs to with what the handler returns", async () => {
    const { app, setup } = open();
    const write = vi.fn((_event: IpcCaller, _text: unknown) => true);
    handleIpc("desktop.clipboard.write", write);
    handleIpc("desktop.setup.quit", () => undefined);

    expect(await mocks.invoke.get("desktop.clipboard.write")?.(app.event, "text")).toBe(true);
    expect(write).toHaveBeenCalledWith(app.event, "text");
    expect(() => mocks.invoke.get("desktop.setup.quit")?.(setup.event)).not.toThrow();
    expect(reportDesktopError).not.toHaveBeenCalled();
  });

  it("refuses and reports every channel for any caller but its window's own page", () => {
    const { app, setup } = open();
    const handler = vi.fn();
    for (const name of names) {
      const { from, sync, refused }: IpcChannel = ipcChannels[name];
      register(name, handler);
      const [own, other] = from === "setup" ? [setup, app] : [app, setup];
      for (const [who, event] of [...strangers(own), ["the other window", other.event] as const]) {
        if (sync) {
          const reply: IpcCaller & { returnValue?: unknown } = { ...event };
          mocks.sync.get(name)?.(reply);
          expect(reply.returnValue, `${name} from ${who}`).toBeNull();
        } else if (refused === REJECTS) {
          expect(() => mocks.invoke.get(name)?.(event), `${name} from ${who}`).toThrow(
            `This page may not call ${name}.`,
          );
        } else {
          expect(mocks.invoke.get(name)?.(event), `${name} from ${who}`).toBe(
            refused === LIVE ? LIVE_ANSWER : refused,
          );
        }
      }
      expect(mocks.invoke.has(name)).toBe(!sync);
      expect(mocks.sync.has(name)).toBe(sync === true);
    }
    expect(handler).not.toHaveBeenCalled();
    // Reported once per channel, however often a page keeps calling.
    expect(vi.mocked(reportDesktopError).mock.calls).toEqual(
      names.map((name) => [expect.any(Error), "desktop.ipc", { "ipc.channel": name }]),
    );
  });

  it("rejects only on the channels whose page has to be told nothing happened", () => {
    expect(names.filter((name) => ipcChannels[name].refused === REJECTS)).toEqual([
      "desktop.computer.requestAccess",
      "desktop.mcpBrowser.clear",
      "desktop.oauth.open",
      "desktop.setup.stack.start",
      "desktop.setup.stack.state",
      "desktop.setup.state",
    ]);
    expect(names.filter((name) => ipcChannels[name].refused === LIVE)).toEqual([
      "desktop.update.check",
      "desktop.update.download",
      "desktop.update.install",
      "desktop.update.state",
    ]);
  });

  it("answers a refused update call with the update state as it is then", async () => {
    const { app } = open();
    let state = { phase: "idle" } as DesktopUpdateState;
    const act = vi.fn(() => ({ ...state, phase: "error" }) as DesktopUpdateState);
    handleIpc("desktop.update.state", act, () => state);
    handleIpc("desktop.update.check", act, () => state);
    handleIpc("desktop.update.download", act, () => state);
    handleIpc("desktop.update.install", act, () => state);
    const page = appBridge(app.event);
    switchServer(app);

    for (const call of ["state", "check", "download", "install"] as const) {
      state = { phase: "ready", availableVersion: call } as DesktopUpdateState;
      await expect(page.update[call](), call).resolves.toBe(state);
    }
    expect(act).not.toHaveBeenCalled();
  });

  it("answers the app's own page while its window is not the app window, as it did before", async () => {
    const { app } = open();
    for (const name of names) if (!ipcChannels[name].sync) register(name, () => "handled");
    const page = appBridge(app.event);
    expect(await page.window.close()).toBe("handled");

    switchServer(app);
    // Dictation cleanup and the calls a page makes without waiting get an answer.
    await expect(page.speech!.stop(1)).resolves.toBeUndefined();
    await expect(page.speech!.abort(1)).resolves.toBeUndefined();
    await expect(page.server!.change()).resolves.toBeUndefined();
    await expect(page.locale!.set("es")).resolves.toBeUndefined();
    await expect(page.computer!.revokeAccess()).resolves.toBeUndefined();
    await expect(page.oauth.cancel!("https://sign-in.invalid")).resolves.toBeUndefined();
    // Calls whose answer the page reads get the one that means nothing was done.
    await expect(page.speech!.start("en-US", 1)).resolves.toBe(false);
    await expect(page.badge!.set(3)).resolves.toBe(false);
    await expect(page.clipboard!.writeText("text")).resolves.toBe(false);
    await expect(page.device!.setAllowed(true)).resolves.toBeNull();
    await expect(page.update.state()).resolves.toBe(LIVE_ANSWER);
    // A sign-in that did not open is a failure its caller handles.
    await expect(page.oauth.open!("https://sign-in.invalid")).rejects.toThrow("may not call");
    // Only its own window's controls are still answered.
    expect(names.filter((name) => ipcChannels[name].from === "appOrReplaced")).toEqual([
      "desktop.window.close",
      "desktop.window.minimize",
      "desktop.window.state",
      "desktop.window.toggleMaximize",
    ]);
    for (const call of ["close", "minimize", "state", "toggleMaximize"] as const)
      await expect(page.window[call](), call).resolves.toBe("handled");
    // The page a switch replaces is expected to keep calling.
    expect(reportDesktopError).not.toHaveBeenCalled();
  });

  it("rejects when the handler fails, whoever would have been refused", async () => {
    const { app } = open();
    handleIpc("desktop.speech.stop", () => {
      throw new Error("recognizer gone");
    });
    await expect(appBridge(app.event).speech!.stop(1)).rejects.toThrow("recognizer gone");
    expect(reportDesktopError).not.toHaveBeenCalled();
  });

  it("reports a channel's refusals again once ten minutes have passed", () => {
    const { setup } = open();
    handleIpc("desktop.badge.set", vi.fn());
    const refused = () => expect(mocks.invoke.get("desktop.badge.set")?.(setup.event)).toBe(false);
    refused();
    refused();
    expect(reportDesktopError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 10 * 60_000);
    refused();
    expect(reportDesktopError).toHaveBeenCalledTimes(2);
  });

  describe("while a server switch keeps the window it replaces", () => {
    const badge = (event: IpcCaller) => mocks.invoke.get("desktop.badge.set")?.(event, 3);
    function switching() {
      const { app: previous, setup } = open();
      const set = vi.fn(() => true);
      handleIpc("desktop.badge.set", set);
      return { previous, setup, set, next: switchServer(previous) };
    }

    it("refuses that window's own page without a report", () => {
      const { previous, set } = switching();
      expect(badge(previous.event)).toBe(false);
      expect(set).not.toHaveBeenCalled();
      expect(reportDesktopError).not.toHaveBeenCalled();
    });

    it.each([
      "its subframe",
      "its frame that is gone",
      "its page on another origin",
      "another window showing the same page",
      "the setup window",
      "the next window before it shows its server",
    ] as const)("refuses and reports %s", (who) => {
      const { previous, setup, set, next } = switching();
      const callers: Record<typeof who, () => IpcCaller> = {
        "its subframe": () => ({ ...previous.event, senderFrame: { ...previous.frame } }) as never,
        "its frame that is gone": () => ({ ...previous.event, senderFrame: null }),
        "its page on another origin": () => {
          previous.frame.url = "https://other.example.com/app/bot";
          return previous.event;
        },
        "another window showing the same page": () => fakeWindow(previous.frame.url).event,
        "the setup window": () => setup.event,
        "the next window before it shows its server": () => {
          next.frame.url = "about:blank";
          return next.event;
        },
      };
      expect(badge(callers[who]())).toBe(false);
      expect(set).not.toHaveBeenCalled();
      expect(reportDesktopError).toHaveBeenCalledTimes(1);
    });

    it("reports the same page again once the switch is over", () => {
      const { previous, set } = switching();
      expect(badge(previous.event)).toBe(false);
      expect(reportDesktopError).not.toHaveBeenCalled();

      // Committed: the window is destroyed and no longer tracked.
      desktop.replacedAppWindow = null;
      expect(badge(previous.event)).toBe(false);
      expect(reportDesktopError).toHaveBeenCalledTimes(1);

      // A window that is gone explains nothing, even while it is still tracked.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      desktop.replacedAppWindow = Object.assign(previous.win, { isDestroyed: () => true });
      expect(badge(previous.event)).toBe(false);
      expect(reportDesktopError).toHaveBeenCalledTimes(2);
      expect(set).not.toHaveBeenCalled();
    });

    it("answers that page again once the switch is abandoned", () => {
      const { previous, set } = switching();
      desktop.mainWindow = previous.win;
      desktop.replacedAppWindow = null;
      expect(badge(previous.event)).toBe(true);
      expect(set).toHaveBeenCalledWith(previous.event, 3);
      expect(reportDesktopError).not.toHaveBeenCalled();
    });

    it("reports that window's page calling a setup channel", () => {
      const { previous } = switching();
      handleIpc("desktop.setup.quit", vi.fn());
      expect(mocks.invoke.get("desktop.setup.quit")?.(previous.event)).toBeUndefined();
      expect(reportDesktopError).toHaveBeenCalledTimes(1);
    });
  });

  it("answers a synchronous channel through the event", () => {
    const { setup } = open();
    const locale = { lang: "es", dir: "ltr" as const, messages: { Continue: "Continuar" } };
    handleIpc("desktop.setup.locale", () => locale);

    const reply: IpcCaller & { returnValue?: unknown } = { ...setup.event };
    mocks.sync.get("desktop.setup.locale")?.(reply);
    expect(reply.returnValue).toBe(locale);
  });
});
