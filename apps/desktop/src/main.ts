import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopReachability, DesktopSetup, DesktopUpdateState } from "@rakazo/contracts";
import { app, BrowserWindow, ipcMain, net, session } from "electron";
import {
  initialUpdateState,
  LAUNCH_CHECK_DELAY_MS,
  reduceUpdateState,
  shouldCheck,
  type UpdaterEvent,
  updaterSupport,
} from "./auto-update.js";
import {
  bundledRendererCandidates,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  normalizeServerUrl,
  parseSetupInput,
  probeFailureMessage,
  resolveStartupTarget,
  servesBundledRenderer,
} from "./setup-config.js";
import { readSetup, writeSetup } from "./setup-store.js";
import { browserWindowOptions, setupWindowOptions, warmWindowTtlMs } from "./window-options.js";

const PERFORMANCE_USER_DATA = process.env.RAKAZO_PERFORMANCE_USER_DATA;
const PROBE_TIMEOUT_MS = 8_000;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let bundledRendererInstalled = false;
let currentSetup: DesktopSetup | null = null;
let currentTargetUrl: string | null = null;
let quitting = false;
let warmWindowTimer: NodeJS.Timeout | undefined;
const WARM_WINDOW_TTL_MS = warmWindowTtlMs(process.env.RAKAZO_WARM_WINDOW_TTL_MS);

const updaterEnvironment = {
  packaged: app.isPackaged,
  version: app.getVersion(),
  disabled: process.env.RAKAZO_DISABLE_AUTO_UPDATE === "1",
};
let updateState: DesktopUpdateState = initialUpdateState(updaterEnvironment);
let lastUpdateCheck = 0;
let updaterWired = false;

markOnce("rk:main:module-evaluated");
if (PERFORMANCE_USER_DATA) {
  app.setPath("userData", PERFORMANCE_USER_DATA);
  app.setPath("sessionData", path.join(PERFORMANCE_USER_DATA, "session"));
}
app.once("will-finish-launching", () => markOnce("rk:main:will-finish-launching"));
app.once("ready", () => markOnce("rk:main:ready"));

function markOnce(name: string) {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

function windowFrom(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

interface ElectronAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on: (event: string, listener: (payload: never) => void) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
}

/** The updater reports failures on an event, not a rejection, so the caller's intent is kept here. */
let updateCheckWasRequested = false;

function pushUpdateEvent(event: UpdaterEvent) {
  updateState = reduceUpdateState(updateState, event, new Date().toISOString());
}

/**
 * Loaded on demand: an unpackaged run has no `app-update.yml`, and importing the updater there
 * only produces a failure the developer cannot act on.
 */
async function loadAutoUpdater(): Promise<ElectronAutoUpdater | null> {
  if (!updaterSupport(updaterEnvironment).supported) return null;
  let updater: ElectronAutoUpdater;
  try {
    const module = await import("electron-updater");
    updater = (module.default ?? module).autoUpdater as unknown as ElectronAutoUpdater;
  } catch (error) {
    pushUpdateEvent({ type: "failed", error, userInitiated: false });
    return null;
  }
  if (!updaterWired) {
    updaterWired = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on("checking-for-update", () => pushUpdateEvent({ type: "check-start" }));
    updater.on("update-available", (info: { version: string }) =>
      pushUpdateEvent({ type: "available", version: info.version }),
    );
    updater.on("update-not-available", () => pushUpdateEvent({ type: "not-available" }));
    updater.on("download-progress", (progress: { percent: number }) =>
      pushUpdateEvent({ type: "progress", percent: progress.percent }),
    );
    updater.on("update-downloaded", (info: { version: string }) =>
      pushUpdateEvent({ type: "downloaded", version: info.version }),
    );
    updater.on("error", (error: Error) =>
      pushUpdateEvent({ type: "failed", error, userInitiated: updateCheckWasRequested }),
    );
  }
  return updater;
}

async function checkForDesktopUpdate(userInitiated: boolean) {
  const now = Date.now();
  if (!shouldCheck(updateState, now, lastUpdateCheck)) return updateState;
  const updater = await loadAutoUpdater();
  if (updater === null) return updateState;
  lastUpdateCheck = now;
  updateCheckWasRequested = userInitiated;
  try {
    await updater.checkForUpdates();
  } catch (error) {
    pushUpdateEvent({ type: "failed", error, userInitiated });
  }
  return updateState;
}

async function downloadDesktopUpdate() {
  if (updateState.phase !== "available") return updateState;
  const updater = await loadAutoUpdater();
  if (updater === null) return updateState;
  pushUpdateEvent({ type: "download-start" });
  try {
    await updater.downloadUpdate();
  } catch (error) {
    pushUpdateEvent({ type: "failed", error, userInitiated: true });
  }
  return updateState;
}

async function installDesktopUpdate() {
  if (updateState.phase !== "ready") return updateState;
  const updater = await loadAutoUpdater();
  if (updater === null) return updateState;
  quitting = true;
  updater.quitAndInstall();
  return updateState;
}

function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

function createWindow(url: string) {
  markOnce("rk:main:window-create-start");
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.on("close", (event) => {
    if (
      process.platform === "darwin" &&
      !quitting &&
      process.env.RAKAZO_DISABLE_WARM_WINDOW !== "1"
    ) {
      event.preventDefault();
      win.hide();
      clearTimeout(warmWindowTimer);
      warmWindowTimer = setTimeout(() => {
        if (mainWindow === win && !win.isDestroyed() && !win.isVisible()) win.destroy();
      }, WARM_WINDOW_TTL_MS);
    }
  });
  win.once("closed", () => {
    clearTimeout(warmWindowTimer);
    if (mainWindow === win) mainWindow = null;
  });
  markOnce("rk:main:window-created");
  if (win.isVisible()) markOnce("rk:main:window-shown");
  win.once("show", () => markOnce("rk:main:window-shown"));
  win.once("ready-to-show", () => markOnce("rk:main:ready-to-show"));
  win.webContents.once("dom-ready", () => markOnce("rk:main:dom-ready"));
  win.webContents.once("did-finish-load", () => markOnce("rk:main:did-finish-load"));
  win.webContents.once("did-stop-loading", () => markOnce("rk:main:did-stop-loading"));
  markOnce("rk:main:load-url-start");
  void win.loadURL(url).then(
    () => markOnce("rk:main:load-url-resolved"),
    () => markOnce("rk:main:load-url-rejected"),
  );
  return win;
}

async function installBundledRenderer(targetUrl: string) {
  if (!app.isPackaged || process.env.RAKAZO_DISABLE_BUNDLED_RENDERER === "1") return;
  if (bundledRendererInstalled || !servesBundledRenderer(targetUrl)) return;
  const webUrl = new URL(targetUrl);
  const root = path.join(process.resourcesPath, "web");
  if (!existsSync(path.join(root, "index.html"))) return;

  await session.defaultSession.protocol.handle(webUrl.protocol.slice(0, -1), async (request) => {
    const forward = () => {
      return net.fetch(request, forwardedRendererRequestInit(request, webUrl.origin));
    };
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
      const headers = new Headers({
        "cache-control": immutableRendererAsset(file)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": contentType(file),
        "x-content-type-options": "nosniff",
      });
      return new Response(body, { headers });
    }
    return forward();
  });
  bundledRendererInstalled = true;
  markOnce("rk:main:bundled-renderer-ready");
}

function createSetupWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...setupWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "setup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  setupWindow = win;
  win.once("closed", () => {
    if (setupWindow === win) setupWindow = null;
  });
  void win.loadFile(path.join(import.meta.dirname, "setup.html"));
  markOnce("rk:main:setup-window-created");
  return win;
}

/** Setup IPC must only answer the setup window, never a connected Rakazo server. */
function fromSetupWindow(event: Electron.IpcMainInvokeEvent) {
  return (
    setupWindow !== null && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents
  );
}

async function probeServer(rawUrl: string): Promise<DesktopReachability> {
  const url = normalizeServerUrl(rawUrl);
  if (url === null) return { ok: false, error: "Enter a valid http:// or https:// address." };

  try {
    const response = await net.fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      ok: response.ok,
      status: response.status,
      url,
      error: response.ok ? undefined : `The server answered with HTTP ${response.status}.`,
    };
  } catch (error) {
    return { ok: false, url, error: probeFailureMessage(error) };
  }
}

async function openApp(targetUrl: string) {
  currentTargetUrl = targetUrl;
  await installBundledRenderer(targetUrl);
  const setup = setupWindow;
  setupWindow = null;
  createWindow(targetUrl);
  if (setup !== null && !setup.isDestroyed()) setup.destroy();
}

app.whenReady().then(async () => {
  if (process.env.RAKAZO_PERFORMANCE_CLEAR_CACHE === "1") {
    await Promise.all([
      session.defaultSession.clearCache(),
      session.defaultSession.clearCodeCaches({}),
    ]);
    markOnce("rk:main:caches-cleared");
  }
  const userDataDir = app.getPath("userData");
  currentSetup = await readSetup(userDataDir);
  const target = resolveStartupTarget({
    envUrl: process.env.RAKAZO_WEB_URL,
    saved: currentSetup,
    forceSetup: process.env.RAKAZO_FORCE_SETUP === "1",
  });
  if (target.kind === "app") currentTargetUrl = target.url;

  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  ipcMain.handle("desktop.platform", () => process.platform);
  ipcMain.handle("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  ipcMain.handle("desktop.window.minimize", (event) => {
    windowFrom(event)?.minimize();
  });
  ipcMain.handle("desktop.window.toggleMaximize", (event) => {
    const win = windowFrom(event);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle("desktop.window.state", (event) => {
    const win = windowFrom(event);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
  ipcMain.handle("desktop.update.state", () => updateState);
  ipcMain.handle("desktop.update.check", () => checkForDesktopUpdate(true));
  ipcMain.handle("desktop.update.download", () => downloadDesktopUpdate());
  ipcMain.handle("desktop.update.install", () => installDesktopUpdate());
  ipcMain.handle("desktop.setup.state", (event) => {
    if (!fromSetupWindow(event)) return null;
    return {
      defaultLocalUrl: DEFAULT_LOCAL_WEB_URL,
      platform: process.platform,
      saved: currentSetup,
    };
  });

  ipcMain.handle("desktop.setup.test", async (event, url: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    if (typeof url !== "string") return { ok: false, error: "Enter a server address." };
    return probeServer(url);
  });

  ipcMain.handle("desktop.setup.save", async (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    const setup = parseSetupInput(payload);
    if (setup === null) return { ok: false, error: "Enter a valid http:// or https:// address." };

    await writeSetup(userDataDir, setup);
    currentSetup = setup;
    // Answer the setup window before tearing it down, otherwise the reply is lost.
    setImmediate(() => void openApp(setup.serverUrl));
    return { ok: true };
  });

  ipcMain.handle("desktop.setup.quit", (event) => {
    if (fromSetupWindow(event)) app.quit();
  });

  if (currentTargetUrl === null) {
    createSetupWindow();
  } else {
    await installBundledRenderer(currentTargetUrl);
    createWindow(currentTargetUrl);
    setTimeout(() => void checkForDesktopUpdate(false), LAUNCH_CHECK_DELAY_MS).unref();
  }

  app.on("activate", () => {
    if (setupWindow !== null && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
      return;
    }
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      clearTimeout(warmWindowTimer);
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (currentTargetUrl === null) createSetupWindow();
    else createWindow(currentTargetUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  clearTimeout(warmWindowTimer);
});
