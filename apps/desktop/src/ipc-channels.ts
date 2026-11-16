import type { RakazoDesktop, RakazoSetup } from "@rakazo/contracts";

/**
 * The window whose own page may call a channel. Its main frame only, and for an app window
 * only while that frame shows the server the window was opened for. `appOrReplaced` also
 * takes the window a server switch is replacing: only for a channel whose handler acts on
 * the window that sent the call and on nothing else.
 */
export type IpcWindow = "app" | "appOrReplaced" | "setup";

type BridgeMethod = (...args: never[]) => unknown;

/**
 * For a channel whose bridge method has no answer that means nothing was done: a refused caller
 * gets a rejection, like a handler that failed. Every page caller of one already takes a failure
 * to mean the thing did not happen. A new answer is not an option: the app window shows whatever
 * release its server runs, and a page written before the answer existed would misread it.
 */
export const REJECTS = Symbol("rejects");

/**
 * For a channel whose answer for nothing done is a value only the main process can read when
 * the call arrives, such as the current update state: `handleIpc` takes a function that reads
 * it, next to the handler.
 */
export const LIVE = Symbol("live");

export type IpcChannel<Method extends BridgeMethod = BridgeMethod> = {
  readonly from: IpcWindow;
  /** Answered through `sendSync`, so the handler cannot wait for anything. */
  readonly sync?: true;
  /**
   * What a refused caller is answered with: the bridge method's own answer for nothing done,
   * or `LIVE` when the registration reads it. The app's page is refused whenever its window is
   * not the app window, as it is while another server is being opened, so this is what the
   * page sees then.
   */
  readonly refused: unknown;
  /** Never set: carries the type of the bridge method the preload backs with this channel. */
  readonly method?: Method;
};

type Refused<Method extends BridgeMethod> = Awaited<ReturnType<Method>> | typeof REJECTS;

const appPage = <Method extends BridgeMethod>(refused: Refused<Method>): IpcChannel<Method> => ({
  from: "app",
  refused,
});
const appPageLive = <Method extends BridgeMethod>(): IpcChannel<Method> & {
  refused: typeof LIVE;
} => ({ from: "app", refused: LIVE });
/**
 * The page's own title-bar buttons are the only window controls where the window has no native
 * frame, and the window a switch is replacing can still be on screen while the next server loads.
 */
const ownWindow = <Method extends BridgeMethod>(refused: Refused<Method>): IpcChannel<Method> => ({
  from: "appOrReplaced",
  refused,
});
const setupPage = <Method extends BridgeMethod>(refused: Refused<Method>): IpcChannel<Method> => ({
  from: "setup",
  refused,
});
/** `sendSync` cannot reject, so a refused caller reads null and the preload supplies English. */
const setupPageSync = <Method extends BridgeMethod>(): IpcChannel<Method> & { sync: true } => ({
  from: "setup",
  sync: true,
  refused: null,
});

const SETUP_NOT_ACTIVE = { ok: false, error: "Setup is not active." };

type Desktop = { [Key in keyof RakazoDesktop]-?: NonNullable<RakazoDesktop[Key]> };

/**
 * Every channel a page can call, and who may call it. Types come from the bridge contracts the
 * pages are written against. `handleIpc` registers from this map and the preloads name the same
 * channels as literal strings: a sandboxed preload can only require `electron`, and the build
 * copies the preloads unbundled. `ipc-channels.test.ts` fails when the three disagree.
 */
export const ipcChannels = {
  "desktop.badge.set": appPage<Desktop["badge"]["set"]>(false),
  "desktop.clipboard.write": appPage<Desktop["clipboard"]["writeText"]>(false),
  "desktop.computer.requestAccess": appPage<Desktop["computer"]["requestAccess"]>(REJECTS),
  "desktop.computer.revokeAccess": appPage<Desktop["computer"]["revokeAccess"]>(undefined),
  "desktop.device.setAllowed": appPage<Desktop["device"]["setAllowed"]>(null),
  "desktop.device.state": appPage<Desktop["device"]["state"]>(null),
  "desktop.locale.set": appPage<Desktop["locale"]["set"]>(undefined),
  "desktop.mcpBrowser.clear": appPage<Desktop["mcpBrowser"]["clear"]>(REJECTS),
  "desktop.monitoring.enabled": appPage<Desktop["monitoring"]["enabled"]>(false),
  "desktop.oauth.cancel": appPage<NonNullable<Desktop["oauth"]["cancel"]>>(undefined),
  "desktop.oauth.open": appPage<NonNullable<Desktop["oauth"]["open"]>>(REJECTS),
  "desktop.passkeys.rpIds": appPage<Desktop["passkeys"]["rpIds"]>([]),
  "desktop.server.change": appPage<Desktop["server"]["change"]>(undefined),
  "desktop.speech.abort": appPage<Desktop["speech"]["abort"]>(undefined),
  "desktop.speech.start": appPage<Desktop["speech"]["start"]>(false),
  "desktop.speech.stop": appPage<Desktop["speech"]["stop"]>(undefined),
  "desktop.update.check": appPageLive<Desktop["update"]["check"]>(),
  "desktop.update.download": appPageLive<Desktop["update"]["download"]>(),
  "desktop.update.install": appPageLive<Desktop["update"]["install"]>(),
  "desktop.update.state": appPageLive<Desktop["update"]["state"]>(),
  "desktop.window.close": ownWindow<Desktop["window"]["close"]>(undefined),
  "desktop.window.minimize": ownWindow<Desktop["window"]["minimize"]>(undefined),
  "desktop.window.state": ownWindow<Desktop["window"]["state"]>({
    minimized: false,
    maximized: false,
    fullScreen: false,
  }),
  "desktop.window.toggleMaximize": ownWindow<Desktop["window"]["toggleMaximize"]>(undefined),
  "desktop.setup.locale": setupPageSync<() => RakazoSetup["locale"]>(),
  "desktop.setup.openLink": setupPage<RakazoSetup["openLink"]>(undefined),
  "desktop.setup.quit": setupPage<RakazoSetup["quit"]>(undefined),
  "desktop.setup.save": setupPage<RakazoSetup["save"]>(SETUP_NOT_ACTIVE),
  "desktop.setup.stack.start": setupPage<RakazoSetup["stack"]["start"]>(REJECTS),
  "desktop.setup.stack.state": setupPage<RakazoSetup["stack"]["state"]>(REJECTS),
  "desktop.setup.state": setupPage<RakazoSetup["state"]>(REJECTS),
  "desktop.setup.test": setupPage<RakazoSetup["test"]>(SETUP_NOT_ACTIVE),
};

export type IpcChannelName = keyof typeof ipcChannels;

type MethodOf<Name extends IpcChannelName> = NonNullable<(typeof ipcChannels)[Name]["method"]>;

/** What the page passes, as its bridge is typed. Handlers still receive each one as `unknown`. */
export type IpcArgs<Name extends IpcChannelName> = Parameters<MethodOf<Name>>;

export type IpcResult<Name extends IpcChannelName> = Awaited<ReturnType<MethodOf<Name>>>;

export type IpcIsSync<Name extends IpcChannelName> = (typeof ipcChannels)[Name] extends {
  sync: true;
}
  ? true
  : false;

/** What `handleIpc` takes after the handler: the refused caller's answer, for a `LIVE` channel only. */
export type IpcRefusedAnswer<Name extends IpcChannelName> = (typeof ipcChannels)[Name] extends {
  refused: typeof LIVE;
}
  ? [refused: () => IpcResult<Name>]
  : [];
