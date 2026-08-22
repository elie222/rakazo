import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopReachability, DesktopSetup } from "@rakazo/contracts";
import { app, BrowserWindow, ipcMain, Menu, net, type Session, session, shell } from "electron";
import {
  bundledRendererCandidates,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  isRakazoHealth,
  normalizeServerUrl,
  parseSetupInput,
  probeFailureMessage,
  resolveStartupTarget,
  safeExternalUrl,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "./setup-config.js";
import { readSetup, writeSetup } from "./setup-store.js";
import { browserWindowOptions, setupWindowOptions, warmWindowTtlMs } from "./window-options.js";

const PERFORMANCE_USER_DATA = process.env.RAKAZO_PERFORMANCE_USER_DATA;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_RESPONSE_LIMIT_BYTES = 64 * 1024;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
const bundledRendererInstallations = new Set<string>();
let currentSetup: DesktopSetup | null = null;
let currentTargetUrl: string | null = null;
let setupError: string | null = null;
let setupSaveInProgress = false;
let openAppPromise: Promise<boolean> | null = null;
let quitting = false;
let warmWindowTimer: NodeJS.Timeout | undefined;
const WARM_WINDOW_TTL_MS = warmWindowTtlMs(process.env.RAKAZO_WARM_WINDOW_TTL_MS);

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

function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

function sessionForTarget(targetUrl: string) {
  const partition = sessionPartitionForServerUrl(targetUrl);
  return {
    partition,
    value: partition === null ? session.defaultSession : session.fromPartition(partition),
  };
}

function createWindow(url: string, partition: string | null) {
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
      ...(partition === null ? {} : { partition }),
    },
  });
  mainWindow = win;
  const targetOrigin = safeOrigin(url);
  win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
    const external = safeExternalUrl(childUrl);
    if (external !== null) void shell.openExternal(external);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    if (targetOrigin !== null && safeOrigin(navigationUrl) === targetOrigin) return;
    event.preventDefault();
  });
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
  const loaded = win.loadURL(url).then(
    () => markOnce("rk:main:load-url-resolved"),
    (error: unknown) => {
      markOnce("rk:main:load-url-rejected");
      throw error;
    },
  );
  return { loaded, win };
}

async function installBundledRenderer(
  targetUrl: string,
  targetSession: Session,
  partition: string | null,
) {
  if (!app.isPackaged || process.env.RAKAZO_DISABLE_BUNDLED_RENDERER === "1") return;
  if (!servesBundledRenderer(targetUrl)) return;
  const webUrl = new URL(targetUrl);
  const installationKey = `${partition ?? "default"}:${webUrl.protocol}`;
  if (bundledRendererInstallations.has(installationKey)) return;
  const root = path.join(process.resourcesPath, "web");

  await targetSession.protocol.handle(webUrl.protocol.slice(0, -1), async (request) => {
    const forward = () => {
      return targetSession.fetch(request, forwardedRendererRequestInit(request, webUrl.origin));
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
  bundledRendererInstallations.add(installationKey);
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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("closed", () => {
    if (setupWindow === win) setupWindow = null;
  });
  void win.loadFile(path.join(import.meta.dirname, "setup.html"));
  markOnce("rk:main:setup-window-created");
  return win;
}

function showSetupWindow(error: string | null = null) {
  currentTargetUrl = null;
  setupError = error;
  const appWindow = mainWindow;
  mainWindow = null;

  let win: BrowserWindow;
  if (setupWindow !== null && !setupWindow.isDestroyed()) {
    if (error !== null) setupWindow.reload();
    win = setupWindow;
  } else {
    win = createSetupWindow();
  }
  if (appWindow !== null && !appWindow.isDestroyed()) appWindow.destroy();
  win.show();
  win.focus();
  return win;
}

function installApplicationMenu() {
  const changeServer: Electron.MenuItemConstructorOptions = {
    id: "change-rakazo-server",
    label: "Change Rakazo Server…",
    accelerator: "CmdOrCtrl+Shift+K",
    click: () => showSetupWindow(),
  };
  const template: Electron.MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              changeServer,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]
      : [
          {
            label: "File",
            submenu: [changeServer, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    const response = await net.fetch(`${url}/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address redirects elsewhere. Enter the final Rakazo server address.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        error: `The server answered with HTTP ${response.status}.`,
      };
    }
    const health = await limitedJson(response);
    if (!isRakazoHealth(health)) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address did not respond like a Rakazo server.",
      };
    }
    return {
      ok: true,
      status: response.status,
      url,
    };
  } catch (error) {
    return { ok: false, url, error: probeFailureMessage(error) };
  }
}

async function limitedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROBE_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function openApp(targetUrl: string) {
  if (openAppPromise !== null) return openAppPromise;
  openAppPromise = openAppOnce(targetUrl).finally(() => {
    openAppPromise = null;
  });
  return openAppPromise;
}

async function openAppOnce(targetUrl: string) {
  const target = sessionForTarget(targetUrl);
  let win: BrowserWindow | null = null;
  try {
    await installBundledRenderer(targetUrl, target.value, target.partition);
    const created = createWindow(targetUrl, target.partition);
    win = created.win;
    await created.loaded;
    currentTargetUrl = targetUrl;
    setupError = null;
    const setup = setupWindow;
    setupWindow = null;
    if (setup !== null && !setup.isDestroyed()) setup.destroy();
    return true;
  } catch (error) {
    if (win !== null && !win.isDestroyed()) win.destroy();
    showSetupWindow(`Could not open that server. ${probeFailureMessage(error)}`);
    return false;
  }
}

function safeOrigin(targetUrl: string) {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  const userDataDir = app.getPath("userData");
  currentSetup = await readSetup(userDataDir);
  const target = resolveStartupTarget({
    envUrl: process.env.RAKAZO_WEB_URL,
    saved: currentSetup,
    forceSetup: process.env.RAKAZO_FORCE_SETUP === "1",
  });
  if (process.env.RAKAZO_PERFORMANCE_CLEAR_CACHE === "1") {
    const cacheSessions = new Set<Session>([session.defaultSession]);
    if (target.kind === "app") cacheSessions.add(sessionForTarget(target.url).value);
    await Promise.all(
      [...cacheSessions].flatMap((value) => [value.clearCache(), value.clearCodeCaches({})]),
    );
    markOnce("rk:main:caches-cleared");
  }

  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  installApplicationMenu();
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
  ipcMain.handle("desktop.setup.state", (event) => {
    if (!fromSetupWindow(event)) return null;
    return {
      defaultLocalUrl: DEFAULT_LOCAL_WEB_URL,
      platform: process.platform,
      saved: currentSetup,
      error: setupError ?? undefined,
    };
  });

  ipcMain.handle("desktop.setup.test", async (event, url: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    if (typeof url !== "string") return { ok: false, error: "Enter a server address." };
    return probeServer(url);
  });

  ipcMain.handle("desktop.setup.save", async (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    if (setupSaveInProgress)
      return { ok: false, error: "A connection attempt is already running." };
    setupSaveInProgress = true;
    try {
      const setup = parseSetupInput(payload);
      if (setup === null) {
        return {
          ok: false,
          error:
            "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.",
        };
      }

      const reachability = await probeServer(setup.serverUrl);
      if (!reachability.ok) return { ok: false, error: reachability.error };

      try {
        await writeSetup(userDataDir, setup);
      } catch {
        return {
          ok: false,
          error: "Could not save setup. Check that Rakazo can write to its app-data directory.",
        };
      }
      currentSetup = setup;
      // Answer the setup window before tearing it down, otherwise the reply is lost.
      setImmediate(() => void openApp(setup.serverUrl));
      return { ok: true };
    } finally {
      setupSaveInProgress = false;
    }
  });

  ipcMain.handle("desktop.setup.quit", (event) => {
    if (fromSetupWindow(event)) app.quit();
  });

  if (target.kind === "setup") {
    showSetupWindow();
  } else if (target.source === "saved") {
    const reachability = await probeServer(target.url);
    if (reachability.ok) {
      await openApp(target.url);
    } else {
      showSetupWindow(`Could not reconnect to the saved server. ${reachability.error}`);
    }
  } else {
    await openApp(target.url);
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
    if (currentTargetUrl === null) showSetupWindow(setupError);
    else void openApp(currentTargetUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  clearTimeout(warmWindowTimer);
});
