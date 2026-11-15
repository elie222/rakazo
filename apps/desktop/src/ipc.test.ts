import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appWindowTargets, desktop } from "./desktop-state.js";
import type { IpcCaller } from "./ipc.js";
import { handleIpc, sentFrom } from "./ipc.js";
import type { IpcChannelName } from "./ipc-channels.js";
import { ipcChannels } from "./ipc-channels.js";
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
      const { from, sync }: { from: "app" | "setup"; sync?: true } = ipcChannels[name];
      handleIpc(name, handler as never);
      const [own, other] = from === "app" ? [app, setup] : [setup, app];
      for (const [who, event] of [...strangers(own), ["the other window", other.event] as const]) {
        if (sync) {
          const reply: IpcCaller & { returnValue?: unknown } = { ...event };
          mocks.sync.get(name)?.(reply);
          expect(reply.returnValue, `${name} from ${who}`).toBeNull();
        } else {
          expect(() => mocks.invoke.get(name)?.(event), `${name} from ${who}`).toThrow(
            `This page may not call ${name}.`,
          );
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

  it("answers a synchronous channel through the event", () => {
    const { setup } = open();
    const locale = { lang: "es", dir: "ltr" as const, messages: { Continue: "Continuar" } };
    handleIpc("desktop.setup.locale", () => locale);

    const reply: IpcCaller & { returnValue?: unknown } = { ...setup.event };
    mocks.sync.get("desktop.setup.locale")?.(reply);
    expect(reply.returnValue).toBe(locale);
  });
});
