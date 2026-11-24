import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "electron";
import { app, BrowserWindow, Menu, nativeTheme, net, screen, session, shell } from "electron";
import {
  mcpLoopbackRefusalFrom,
  mcpOAuthCallbackFrom,
  oauthCallbackFrom,
} from "../auth/oauth-callback.js";
import { appWindowTargets, desktop } from "../desktop-state.js";
import { t, withDetail } from "../i18n.js";
import {
  probeFailureMessage,
  safeExternalUrl,
  serverHeadersFor,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "../setup/setup-config.js";
import { reportDesktopError } from "../system/monitoring.js";
import { LAUNCH_CHECK_DELAY_MS } from "../updates/auto-update.js";
import type { AppDocumentState } from "./app-document-state.js";
import { waitForMountedAppDocument } from "./app-document-state.js";
import { contextMenuTemplate } from "./context-menu.js";
import { historyTarget } from "./history-navigation.js";
import {
  bundledRendererCandidates,
  bundledRendererHeaders,
  forwardedRendererRequestInit,
  isRendererAssetMiss,
} from "./renderer-assets.js";
import { installRendererRecovery } from "./renderer-recovery.js";
import {
  mcpOAuthPartition,
  mcpOAuthPopupServerId,
  oauthPopupSessionPreferences,
  shouldOpenInAppPopup,
} from "./window-open.js";
import type { SavedBackground, SavedWindowBounds } from "./window-options.js";
import {
  appWindowBackground,
  browserWindowOptions,
  developmentIconFile,
  paintedBackground,
  parseSavedBackground,
  parseSavedWindowBounds,
  restorableWindowBounds,
  systemWindowBackground,
  warmWindowTtlMs,
} from "./window-options.js";

export const PROBE_TIMEOUT_MS = 8_000;
/** The server or the network refused the page; the setup window says so and the server logs its side. */
export class ServerUnavailable extends Error {}
const bundledRendererInstallations = new Set<string>();
const WARM_WINDOW_TTL_MS = warmWindowTtlMs(process.env.RAKAZO_WARM_WINDOW_TTL_MS);
/** Test hook: how long a loaded page may take to mount the app before the server is rejected. */
const appMountTimeout = Number(process.env.RAKAZO_APP_MOUNT_TIMEOUT_MS);
const APP_MOUNT_TIMEOUT_MS = appMountTimeout > 0 ? appMountTimeout : undefined;
export function markOnce(name: string) {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}
/** Dock/taskbar icon for unpackaged launches; packaged builds get theirs from electron-builder. */
export function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", developmentIconFile(process.platform));
  return existsSync(icon) ? icon : undefined;
}
function sessionPartitionKey(targetUrl: string) {
  return sessionPartitionForServerUrl(targetUrl);
}
function legacyDefaultSessionFlag(partition: string) {
  return path.join(
    app.getPath("userData"),
    `legacy-default-${partition.replace(/[^a-zA-Z0-9_-]/g, "_")}.flag`,
  );
}
/**
 * Prefer the default session when that origin already has cookies or site
 * storage there, so upgrades keep localStorage/IndexedDB. Fresh origins get
 * an isolated partition.
 */
export async function resolveSessionForTarget(targetUrl: string) {
  const partition = sessionPartitionKey(targetUrl);
  if (partition === null) {
    return { partition: null, value: session.defaultSession };
  }
  if (existsSync(legacyDefaultSessionFlag(partition))) {
    return { partition: null, value: session.defaultSession };
  }
  const origin = safeOrigin(targetUrl);
  if (origin !== null) {
    try {
      const defaultCookies = await session.defaultSession.cookies.get({ url: origin });
      if (defaultCookies.length > 0) {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
        return { partition: null, value: session.defaultSession };
      }
    } catch {
      // Continue with a storage probe when the profile looks pre-partition.
    }
    if (defaultSessionProfileExists() && (await defaultSessionHasOriginData(origin))) {
      try {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
      } catch {
        // Flag is best-effort; still stay on the default session this launch.
      }
      return { partition: null, value: session.defaultSession };
    }
  }
  return { partition, value: session.fromPartition(partition) };
}
function defaultSessionProfileExists() {
  const root = app.getPath("userData");
  return (
    existsSync(path.join(root, "Local Storage")) ||
    existsSync(path.join(root, "IndexedDB")) ||
    existsSync(path.join(root, "Cookies")) ||
    existsSync(path.join(root, "Network", "Cookies")) ||
    existsSync(path.join(root, "Cache Storage"))
  );
}
/** Page storage in the default session means a pre-partition install for this origin. */
async function defaultSessionHasOriginData(origin: string): Promise<boolean> {
  const probe = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Increment only after construction succeeds so a throw cannot leave the
  // counter stuck > 0 and permanently block quit on Windows/Linux.
  desktop.liveProbeWindows++;
  try {
    await probe.loadURL(origin);
    return (await probe.webContents.executeJavaScript(`(async () => {
      if (localStorage.length > 0 || sessionStorage.length > 0) return true;
      if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        try {
          const databases = await indexedDB.databases();
          if (databases.length > 0) return true;
        } catch {}
      }
      if (typeof caches !== "undefined") {
        try {
          const keys = await caches.keys();
          if (keys.length > 0) return true;
        } catch {}
      }
      return false;
    })()`)) as boolean;
  } catch {
    return false;
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
    desktop.liveProbeWindows--;
  }
}
function windowBackgroundFile() {
  return path.join(app.getPath("userData"), "window-background");
}
function lastPaintedBackground() {
  try {
    return parseSavedBackground(readFileSync(windowBackgroundFile(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      reportDesktopError(error, "desktop.startup");
    return null;
  }
}
/** Written at once: a few bytes, only when the page's colors change, and a quit cannot drop it. */
function saveBackground(saved: SavedBackground) {
  try {
    writeFileSync(windowBackgroundFile(), JSON.stringify(saved));
  } catch (error) {
    reportDesktopError(error, "desktop.startup");
  }
}
const SAVE_BOUNDS_DELAY_MS = 500;
function windowBoundsFile() {
  return path.join(app.getPath("userData"), "window-bounds.json");
}
function savedWindowBounds() {
  let text: string;
  try {
    text = readFileSync(windowBoundsFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      reportDesktopError(error, "desktop.startup");
    return null;
  }
  return restorableWindowBounds(
    parseSavedWindowBounds(text),
    screen.getAllDisplays().map((display) => display.workArea),
  );
}
function currentWindowBounds(win: BrowserWindow): SavedWindowBounds {
  return { ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
}
/** Synchronous, so a later save can never land before an earlier one and quitting cannot lose it. */
function saveWindowBounds(win: BrowserWindow) {
  try {
    writeFileSync(windowBoundsFile(), JSON.stringify(currentWindowBounds(win)), "utf8");
  } catch (error) {
    reportDesktopError(error, "desktop.startup");
  }
}
/** Remembers where the app window is so the next one opens there; a replaced window stops counting. */
function rememberWindowBounds(win: BrowserWindow) {
  let timer: NodeJS.Timeout | undefined;
  const current = () => desktop.mainWindow === win && !win.isDestroyed();
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (current()) saveWindowBounds(win);
    }, SAVE_BOUNDS_DELAY_MS);
  };
  win.on("move", saveSoon);
  win.on("resize", saveSoon);
  win.on("maximize", saveSoon);
  win.on("unmaximize", saveSoon);
  win.on("enter-full-screen", saveSoon);
  win.on("leave-full-screen", saveSoon);
  win.on("close", () => {
    clearTimeout(timer);
    if (current()) saveWindowBounds(win);
  });
  win.once("closed", () => clearTimeout(timer));
}
export function createWindow(url: string, partition: string | null) {
  markOnce("rk:main:window-create-start");
  const icon = developmentIcon();
  // A window being replaced may have moved within the save delay; record it so this one opens there.
  if (desktop.mainWindow && !desktop.mainWindow.isDestroyed()) saveWindowBounds(desktop.mainWindow);
  const saved = savedWindowBounds();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform, screen.getPrimaryDisplay().workAreaSize),
    backgroundColor: appWindowBackground(lastPaintedBackground(), nativeTheme.shouldUseDarkColors),
    ...(saved === null
      ? {}
      : {
          x: saved.x,
          y: saved.y,
          width: saved.width,
          height: saved.height,
          fullscreen: saved.fullScreen,
        }),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Cache the page's compiled scripts on their first load, not only after Chromium has
      // seen them run a few times, so the launch right after an update is fast too.
      v8CacheOptions: "bypassHeatCheck",
      ...(partition === null ? {} : { partition }),
    },
  });
  if (saved?.maximized === true && !saved.fullScreen) win.maximize();
  // The page names its background in its theme-color meta tag, including an appearance picked
  // in settings; the window keeps it for resizes and opens in it next time.
  win.webContents.on("did-change-theme-color", (_event, color) => {
    const background = paintedBackground(color);
    if (background === null) return;
    win.setBackgroundColor(background);
    saveBackground({ color: background, systemUsesDarkColors: nativeTheme.shouldUseDarkColors });
  });
  win.on("unresponsive", () =>
    reportDesktopError(new Error("Renderer unresponsive"), "desktop.unresponsive"),
  );
  desktop.mainWindow = win;
  appWindowTargets.set(win, url);
  rememberWindowBounds(win);
  const targetOrigin = safeOrigin(url);
  // Intentional OAuth flows open the provider's authorize page via a named
  // window; give those and same-origin popups a normal frame. Everything else
  // opens in the system browser so a connected server cannot navigate us away.
  // Hoisted for loopback OAuth capture so MCP/in-app localhost callbacks are skipped.
  const appOrigin = targetOrigin ?? safeOrigin(url);
  win.webContents.setWindowOpenHandler(({ url: childUrl, frameName }) => {
    if (shouldOpenInAppPopup(appOrigin, childUrl, frameName)) {
      // An MCP server signs in through a jar of its own so accounts never mix.
      const mcpServerId = mcpOAuthPopupServerId(frameName);
      return {
        action: "allow",
        overrideBrowserWindowOptions: oauthPopupWindowOptions(
          mcpServerId === null ? partition : mcpOAuthPartition(url, mcpServerId),
        ),
      };
    }
    const external = safeExternalUrl(childUrl);
    if (external !== null) void shell.openExternal(external);
    return { action: "deny" };
  });
  // Signing in lands on a new page; pair then instead of waiting for the next launch.
  const pairAfterNavigation = () => {
    if (desktop.mainWindow === win) void desktop.userDevices?.pair();
  };
  win.webContents.on("did-navigate", pairAfterNavigation);
  win.webContents.on("did-navigate-in-page", pairAfterNavigation);
  // Server redirects skip will-navigate, so a same-origin link could otherwise land elsewhere.
  const keepOnAppOrigin = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!event.isMainFrame) return;
    if (targetOrigin !== null && safeOrigin(event.url) === targetOrigin) return;
    event.preventDefault();
    const external = safeExternalUrl(event.url);
    if (external !== null) void shell.openExternal(external);
  };
  win.webContents.on("context-menu", (_event, params) => {
    Menu.buildFromTemplate(contextMenuTemplate(params)).popup({ window: win });
  });
  // Trackpad swipes and mouse side buttons step through the app's history, as in a browser.
  // Each server has its own window, so its history starts at this server's first page.
  const stepHistory = (gesture: string) => {
    const history = win.webContents.navigationHistory;
    const index = historyTarget(
      gesture,
      {
        urls: history.getAllEntries().map((entry) => entry.url),
        activeIndex: history.getActiveIndex(),
      },
      targetOrigin,
    );
    if (index !== null) history.goToIndex(index);
  };
  win.on("swipe", (_event, direction) => stepHistory(direction));
  win.on("app-command", (_event, command) => stepHistory(command));
  win.webContents.on("will-navigate", keepOnAppOrigin);
  win.webContents.on("will-redirect", keepOnAppOrigin);
  // The popup has no address bar, so a loopback redirect would otherwise strand
  // the user on a blank window holding the authorization code in a URL they
  // cannot read. Capture it here and hand it to the app instead.
  win.webContents.on("did-create-window", (popup, { frameName }) => {
    const mcpServerId = mcpOAuthPopupServerId(frameName);
    const capture = (details: {
      preventDefault: () => void;
      url: string;
      isMainFrame?: boolean;
    }) => {
      // will-redirect can fire for iframes; only the top-level callback counts.
      if (details.isMainFrame === false) return;
      if (mcpServerId !== null && appOrigin !== null) {
        // The app's own callback, or a refusal on a loopback redirect that is not the app's.
        const mcpCallback =
          mcpOAuthCallbackFrom(details.url, appOrigin) ??
          (safeOrigin(details.url) === appOrigin ? undefined : mcpLoopbackRefusalFrom(details.url));
        if (mcpCallback) {
          details.preventDefault();
          if (!win.isDestroyed())
            win.webContents.send("desktop.mcpBrowser.callback", {
              serverId: mcpServerId,
              ...mcpCallback,
            });
          if (!popup.isDestroyed()) popup.close();
          return;
        }
      }
      const callback = oauthCallbackFrom(details.url, {
        frameName,
        excludeOrigins: appOrigin !== null ? [appOrigin] : [],
      });
      if (!callback) return;
      details.preventDefault();
      if (!win.isDestroyed()) win.webContents.send("desktop.oauth.callback", callback);
      if (!popup.isDestroyed()) popup.close();
    };
    popup.webContents.on("will-redirect", (details) => capture(details));
    popup.webContents.on("will-navigate", (details) => capture(details));
  });
  win.on("close", (event) => {
    if (
      process.platform === "darwin" &&
      !desktop.quitting &&
      process.env.RAKAZO_DISABLE_WARM_WINDOW !== "1"
    ) {
      event.preventDefault();
      win.hide();
      clearTimeout(desktop.warmWindowTimer);
      desktop.warmWindowTimer = setTimeout(() => {
        if (desktop.mainWindow === win && !win.isDestroyed() && !win.isVisible()) win.destroy();
      }, WARM_WINDOW_TTL_MS);
    }
  });
  win.once("closed", () => {
    clearTimeout(desktop.warmWindowTimer);
    if (desktop.mainWindow === win) desktop.mainWindow = null;
  });
  markOnce("rk:main:window-created");
  if (win.isVisible()) markOnce("rk:main:window-shown");
  win.once("show", () => markOnce("rk:main:window-shown"));
  win.once("ready-to-show", () => markOnce("rk:main:ready-to-show"));
  win.webContents.once("dom-ready", () => markOnce("rk:main:dom-ready"));
  win.webContents.once("did-finish-load", () => markOnce("rk:main:did-finish-load"));
  win.webContents.once("did-stop-loading", () => markOnce("rk:main:did-stop-loading"));
  markOnce("rk:main:load-url-start");
  const loaded = loadAppUrl(win, url).then(
    (state) => {
      installRendererRecovery(win, () => desktop.quitting);
      markOnce("rk:main:load-url-resolved");
      return state;
    },
    (error: unknown) => {
      markOnce("rk:main:load-url-rejected");
      throw error;
    },
  );
  if (!desktop.launchUpdateCheckScheduled) {
    desktop.launchUpdateCheckScheduled = true;
    setTimeout(() => void desktop.desktopUpdater.check(false), LAUNCH_CHECK_DELAY_MS).unref();
    setInterval(() => void desktop.desktopUpdater.check(false), 60 * 60 * 1_000).unref();
  }
  return { loaded, win };
}
export async function probeDocument(url: string): Promise<ServerUnavailable | null> {
  // Test/dev harnesses may load data: or file: documents; only probe real servers.
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const response = await net.fetch(url, {
      method: "GET",
      ...(desktop.currentSetup?.headers
        ? { headers: serverHeadersFor(url, desktop.currentSetup) }
        : {}),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Allow 3xx (e.g. / → /login); reject hard HTTP errors before opening a window.
    if (response.status >= 400) {
      return withDetail(
        new ServerUnavailable(`The server answered with HTTP ${response.status}.`),
        t("The server answered with HTTP {status}.", { status: response.status }),
      );
    }
    return null;
  } catch (error) {
    const detail = probeFailureMessage(error);
    return withDetail(new ServerUnavailable(detail), detail);
  }
}
/**
 * loadURL alone treats many HTTP error documents as success. Reject main-frame
 * failures, renderer crashes during load, HTTP 4xx/5xx main-frame responses, and
 * shells that never mount application content.
 */
function loadAppUrl(win: BrowserWindow, url: string): Promise<AppDocumentState> {
  const contents = win.webContents;
  const targetSession = contents.session;
  let mainStatus: number | undefined;

  targetSession.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
    if (details.webContentsId === contents.id && details.resourceType === "mainFrame") {
      mainStatus = details.statusCode;
    }
  });

  return new Promise<AppDocumentState>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      contents.removeListener("did-fail-load", onFail);
      // Keep render-process-gone until document readiness finishes so a crash
      // during mount still fails the switch.
      targetSession.webRequest.onCompleted(null);
      if (error) {
        contents.removeListener("render-process-gone", onGone);
        reject(error);
        return;
      }
      if (mainStatus !== undefined && mainStatus >= 400) {
        contents.removeListener("render-process-gone", onGone);
        reject(
          withDetail(
            new ServerUnavailable(`The server answered with HTTP ${mainStatus}.`),
            t("The server answered with HTTP {status}.", { status: mainStatus }),
          ),
        );
        return;
      }
      void waitForMountedAppDocument(contents, APP_MOUNT_TIMEOUT_MS)
        .then((state) => {
          contents.removeListener("render-process-gone", onGone);
          if (contents.isCrashed()) {
            reject(
              withDetail(
                new Error("Renderer stopped after load."),
                t("Renderer stopped after load."),
              ),
            );
            return;
          }
          resolve(state);
        })
        .catch((inspectError: unknown) => {
          contents.removeListener("render-process-gone", onGone);
          reject(inspectError instanceof Error ? inspectError : new Error(String(inspectError)));
        });
    };

    const onFail = (
      _event: Electron.Event,
      _errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      settle(
        errorDescription
          ? new ServerUnavailable(errorDescription)
          : withDetail(new ServerUnavailable("Page failed to load."), t("Page failed to load.")),
      );
    };
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      settle(
        withDetail(
          new Error(`Renderer stopped (${details.reason}).`),
          t("Renderer stopped ({reason}).", { reason: details.reason }),
        ),
      );
    };

    contents.on("did-fail-load", onFail);
    contents.on("render-process-gone", onGone);
    void contents.loadURL(url).then(
      async () => {
        // onCompleted can lag loadURL; wait briefly for the main-frame status.
        const deadline = Date.now() + 500;
        while (mainStatus === undefined && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        settle();
      },
      (error: unknown) => {
        settle(new ServerUnavailable(error instanceof Error ? error.message : String(error)));
      },
    );
  });
}
export async function installBundledRenderer(
  targetUrl: string,
  targetSession: Session,
  partition: string | null,
  managedLocalStack: boolean,
) {
  if (!app.isPackaged || process.env.RAKAZO_DISABLE_BUNDLED_RENDERER === "1") return;
  if (!servesBundledRenderer(targetUrl, managedLocalStack)) return;
  const webUrl = new URL(targetUrl);
  const installationKey = `${partition ?? "default"}:${webUrl.protocol}`;
  if (bundledRendererInstallations.has(installationKey)) return;
  const root = path.join(process.resourcesPath, "web");

  await targetSession.protocol.handle(webUrl.protocol.slice(0, -1), async (request) => {
    const forward = () => {
      return targetSession.fetch(request, forwardedRendererRequestInit(request, webUrl.origin));
    };
    // Mode can change on the same origin/session; only managed "new" keeps the overlay.
    if (desktop.currentSetup?.mode !== "new") {
      return forward();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return forward();
    }
    const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    const candidates = bundledRendererCandidates(root, request.url, webUrl.origin, acceptsHtml);
    if (!candidates) return forward();
    for (const file of candidates) {
      let body: Buffer | null = null;
      try {
        if (request.method === "HEAD") {
          if (!(await stat(file)).isFile()) continue;
        } else {
          body = await readFile(file);
        }
      } catch (error) {
        if (isRendererAssetMiss(error)) continue;
        throw error;
      }
      return new Response(body, { headers: bundledRendererHeaders(file, request.url) });
    }
    return forward();
  });
  bundledRendererInstallations.add(installationKey);
  markOnce("rk:main:bundled-renderer-ready");
}
function oauthPopupWindowOptions(partition: string | null) {
  return {
    width: 560,
    height: 720,
    frame: true,
    titleBarStyle: "default" as const,
    autoHideMenuBar: true,
    backgroundColor: systemWindowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: oauthPopupSessionPreferences(partition),
  };
}
/** The server the app window shows, unless it is the app-managed local stack. */
export function remoteServerOrigin() {
  if (
    desktop.currentSetup?.mode === "new" ||
    desktop.mainWindow === null ||
    desktop.mainWindow.isDestroyed()
  )
    return null;
  const target = appWindowTargets.get(desktop.mainWindow);
  return target === undefined ? null : safeOrigin(target);
}
function safeOrigin(targetUrl: string) {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return null;
  }
}
