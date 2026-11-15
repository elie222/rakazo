import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { RakazoDesktop } from "@rakazo/contracts";
import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appWindowTargets, desktop } from "./desktop-state.js";
import type { IpcCaller } from "./ipc.js";
import { handleIpc, sentFrom } from "./ipc.js";
import type { IpcChannel, IpcChannelName } from "./ipc-channels.js";
import { ipcChannels, REJECTS } from "./ipc-channels.js";
import { reportDesktopError } from "./monitoring.js";

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
vi.mock("./monitoring.js", () => ({ reportDesktopError: vi.fn() }));

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
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "preload.cjs"), "utf8"), {
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
  });
  return bridge!;
}

beforeEach(() => {
  mocks.invoke.clear();
  mocks.sync.clear();
  vi.mocked(reportDesktopError).mockClear();
  desktop.mainWindow = null;
  desktop.setupWindow = null;
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
    for (const name of Object.keys(ipcChannels) as IpcChannelName[]) {
      const { from, sync, refused }: IpcChannel = ipcChannels[name];
      handleIpc(name, handler as never);
      const [own, other] = from === "app" ? [app, setup] : [setup, app];
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
          expect(mocks.invoke.get(name)?.(event), `${name} from ${who}`).toBe(refused);
        }
      }
      expect(mocks.invoke.has(name)).toBe(!sync);
      expect(mocks.sync.has(name)).toBe(sync === true);
    }
    expect(handler).not.toHaveBeenCalled();
    // Reported once per channel, however often a page keeps calling.
    expect(vi.mocked(reportDesktopError).mock.calls).toEqual(
      Object.keys(ipcChannels).map((name) => [
        expect.any(Error),
        "desktop.ipc",
        { "ipc.channel": name },
      ]),
    );
  });

  it("rejects only on the channels whose page has to be told nothing happened", () => {
    const rejecting = (Object.keys(ipcChannels) as IpcChannelName[]).filter(
      (name) => ipcChannels[name].refused === REJECTS,
    );
    expect(rejecting).toEqual([
      "desktop.computer.requestAccess",
      "desktop.mcpBrowser.clear",
      "desktop.oauth.open",
      "desktop.update.check",
      "desktop.update.download",
      "desktop.update.install",
      "desktop.update.state",
      "desktop.setup.stack.start",
      "desktop.setup.stack.state",
      "desktop.setup.state",
    ]);
  });

  it("answers the app's own page while its window is not the app window, as it did before", async () => {
    const { app } = open();
    for (const name of Object.keys(ipcChannels) as IpcChannelName[]) {
      if (!ipcChannels[name].sync) handleIpc(name, (() => "handled") as never);
    }
    const page = appBridge(app.event);
    expect(await page.window.close()).toBe("handled");

    // Another server is opening: its window is the app window now.
    const next = fakeWindow("https://next.example.com/app");
    desktop.mainWindow = next.win;
    appWindowTargets.set(next.win, "https://next.example.com");
    // Dictation cleanup and the calls a page makes without waiting get an answer.
    await expect(page.speech!.stop(1)).resolves.toBeUndefined();
    await expect(page.speech!.abort(1)).resolves.toBeUndefined();
    await expect(page.window.close()).resolves.toBeUndefined();
    await expect(page.window.minimize()).resolves.toBeUndefined();
    await expect(page.server!.change()).resolves.toBeUndefined();
    await expect(page.locale!.set("es")).resolves.toBeUndefined();
    await expect(page.computer!.revokeAccess()).resolves.toBeUndefined();
    await expect(page.oauth.cancel!("https://sign-in.invalid")).resolves.toBeUndefined();
    // Calls whose answer the page reads get the one that means nothing was done.
    await expect(page.speech!.start("en-US", 1)).resolves.toBe(false);
    await expect(page.badge!.set(3)).resolves.toBe(false);
    await expect(page.clipboard!.writeText("text")).resolves.toBe(false);
    await expect(page.device!.setAllowed(true)).resolves.toBeNull();
    // A sign-in that did not open and an update that was not read are failures their callers handle.
    await expect(page.oauth.open!("https://sign-in.invalid")).rejects.toThrow("may not call");
    await expect(page.update.state()).rejects.toThrow("may not call");
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
    const [name] = Object.keys(ipcChannels).filter(
      (channel) => ipcChannels[channel as IpcChannelName].from === "app",
    ) as IpcChannelName[];
    handleIpc(name!, vi.fn() as never);
    const refused = () => expect(mocks.invoke.get(name!)?.(setup.event)).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60_000 });
    try {
      refused();
      refused();
      expect(reportDesktopError).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 10 * 60_000);
      refused();
      expect(reportDesktopError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
