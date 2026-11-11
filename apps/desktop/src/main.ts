import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HostScreen } from "@rakazo/adapters/host-screen";
import { startUserDeviceClient } from "@rakazo/adapters/user-device-client";
import type { DesktopReachability, DesktopSetup, RakazoDesktopDevice } from "@rakazo/contracts";
import type { BrowserWindow, Session } from "electron";
import {
  app,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron";
import { fromAppFrame } from "./app-frame.js";
import { applicationMenuInstaller, installUpdate } from "./app-menu.js";
import { createAppOpener } from "./app-opener.js";
import {
  createWindow,
  developmentIcon,
  fromMainWindow,
  handleOnlyFrom,
  installBundledRenderer,
  markOnce,
  PROBE_TIMEOUT_MS,
  permissionTarget,
  probeDocument,
  remoteServerOrigin,
  resolveSessionForTarget,
  ServerUnavailable,
  safeOrigin,
  windowFrom,
} from "./app-window.js";
import type { ElectronAutoUpdater } from "./auto-update.js";
import { DesktopUpdateController } from "./auto-update.js";
import { createBadgeHandler } from "./badge.js";
import { openBrowserAuth } from "./browser-auth.js";
import { appWindowTargets, desktop } from "./desktop-state.js";
import { runDocker } from "./docker-cli.js";
import { prepareHostComputer } from "./host-computer.js";
import {
  createDesktopHostScreen,
  screenDriverInstaller,
  screenDriverRelease,
} from "./host-screen.js";
import { createLocaleHandler, errorDetail, startDesktopLocale, t, withDetail } from "./i18n.js";
import { verifyDownloadedLinuxUpdate } from "./linux-update-signature.js";
import { createLocalComputerChoice, saveLocalComputerHost } from "./local-settings.js";
import {
  LocalStackController,
  readStackToken,
  readStackWebUrl,
  resolveImageTag,
  stackDir,
  stackResourceDir,
} from "./local-stack.js";
import {
  configureDesktopMonitoring,
  desktopReportsErrors,
  disableDesktopMonitoring,
  installDesktopEarlyErrorReporting,
  refreshDesktopMonitoringUser,
  reportDesktopError,
} from "./monitoring.js";
import { associatedPasskeyRpIds } from "./passkeys.js";
import { revealSecondInstanceWindow, secondInstanceWindow } from "./second-instance.js";
import { installServerHeaders } from "./server-request-headers.js";
import { installSessionPermissions } from "./session-permissions.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  desktopStackImageTag,
  isRakazoHealth,
  managedLocalOpenUrl,
  maySendDesktopStackToken,
  normalizeServerUrl,
  probeFailureMessage,
  readProbeJson,
  resolveStartupTarget,
} from "./setup-config.js";
import { clearSetup, readSetup, readUiLocale, writeSetup, writeUiLocale } from "./setup-store.js";
import { destroySetupWindow, registerSetupIpc, showSetupWindow } from "./setup-window.js";
import { createSystemSpeech } from "./system-speech.js";
import { createUserDeviceAccess, deviceName } from "./user-device.js";

process.setSourceMapsEnabled(true);
installDesktopEarlyErrorReporting();
const PERFORMANCE_USER_DATA = process.env.RAKAZO_PERFORMANCE_USER_DATA;
/** Test hook: where the app-managed stack answers. Mode `new` still requires loopback. */
const LOCAL_WEB_URL = process.env.RAKAZO_LOCAL_WEB_URL?.trim() || DEFAULT_LOCAL_WEB_URL;
const DESKTOP_STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
let monitoringSession: Session | undefined;
let monitoringTargetUrl: string | undefined;
let stopMonitoringSession: (() => void) | undefined;
const appOpener = createAppOpener(openAppOnce);
/** Prior app window kept until setup is persisted (or the switch is abandoned). */
let pendingPreviousWindow: BrowserWindow | null = null;
const reportsErrors = desktopReportsErrors(app.isPackaged);
const updaterEnvironment = {
  // A `--dir` build has no update feed to read.
  packaged: app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml")),
  version: app.getVersion(),
  disabled: process.env.RAKAZO_DISABLE_AUTO_UPDATE === "1",
};
let requestingComputerAccess = false;
let hostScreen: HostScreen | undefined;
markOnce("rk:main:module-evaluated");
if (PERFORMANCE_USER_DATA) {
  app.setPath("userData", PERFORMANCE_USER_DATA);
  app.setPath("sessionData", path.join(PERFORMANCE_USER_DATA, "session"));
}
app.once("will-finish-launching", () => markOnce("rk:main:will-finish-launching"));
app.once("ready", () => markOnce("rk:main:ready"));
// Includes fresh partitions and popup-created sessions, before they load remote content.
app.on("session-created", (value) => installSessionPermissions(value, permissionTarget));
const passkeyRpIds = associatedPasskeyRpIds({
  platform: process.platform,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  exists: existsSync,
});
// Routes WebAuthn to the system passkey sheet (iCloud Keychain and other providers).
if (passkeyRpIds.length > 0) app.configureWebAuthn({ platformPasskeys: true });
async function saveHostChoice(computerHost: "docker" | "this-mac") {
  const origin = new URL(desktop.localStack.webUrl()).origin;
  const token = await readStackToken(stackDir(app.getPath("userData")));
  if (!token || !(await desktop.localStack.matchesDesiredStack()))
    throw new Error(t("Local server is unavailable"));
  await saveLocalComputerHost({ origin, token }, computerHost, (input, init) =>
    net.fetch(input instanceof URL ? input.href : input, {
      ...init,
      bypassCustomProtocolHandlers: true,
    }),
  );
}
const localComputerChoice = createLocalComputerChoice({
  save: saveHostChoice,
  revoke: () => desktop.hostComputer?.revoke(),
  settled: () => installApplicationMenu(),
});
const persistHostChoice = localComputerChoice.persist;
const revokeLocalComputerAccess = localComputerChoice.revoke;
const installApplicationMenu = applicationMenuInstaller({
  revokeLocalComputerAccess,
  updaterEnvironment,
});
async function probeServer(
  rawUrl: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<DesktopReachability> {
  const url = normalizeServerUrl(rawUrl);
  if (url === null) return { ok: false, error: t("Enter a valid http:// or https:// address.") };
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  try {
    const response = await net.fetch(`${url}/rpc/health`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        url,
        error: t("That address redirects elsewhere. Enter the final Rakazo server address."),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        error: t("The server answered with HTTP {status}.", { status: response.status }),
      };
    }
    const health = await readProbeJson(response);
    if (!isRakazoHealth(health)) {
      return {
        ok: false,
        status: response.status,
        url,
        error: t("That address did not respond like a Rakazo server."),
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
/** A public health response is not enough: another checkout may own the same fixed port. */
async function probeManagedStack(
  rawUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = normalizeServerUrl(rawUrl);
  // Never put the private stack token on a cleartext LAN or .local hop.
  if (url === null || !maySendDesktopStackToken(url)) return null;
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${url}${DESKTOP_STACK_PROBE_PATH}`, {
      method: "GET",
      headers: { [DESKTOP_STACK_TOKEN_HEADER]: token },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    return desktopStackImageTag(await readProbeJson(response));
  } catch {
    return null;
  }
}
/**
 * Failures raised here carry their translated detail; any other is a network error. Their
 * messages stay English for error reports.
 */
function openFailureDetail(error: unknown): string {
  return errorDetail(error) ?? probeFailureMessage(error);
}
function activateDesktopMonitoring(url: string | undefined, targetSession?: Session) {
  if (monitoringTargetUrl === url && monitoringSession === targetSession) return;
  stopMonitoringSession?.();
  stopMonitoringSession = undefined;
  monitoringTargetUrl = url;
  monitoringSession = targetSession;
  if (!url || !targetSession) {
    disableDesktopMonitoring();
    return;
  }
  const fetchMonitoringConfig = () =>
    targetSession.fetch(new URL("/api/monitoring/config", url).href, {
      signal: AbortSignal.timeout(8_000),
    });
  const refreshMonitoringUser = () => {
    if (monitoringSession === targetSession && monitoringTargetUrl === url)
      void refreshDesktopMonitoringUser(fetchMonitoringConfig);
  };
  targetSession.cookies.on("changed", refreshMonitoringUser);
  stopMonitoringSession = () =>
    targetSession.cookies.removeListener("changed", refreshMonitoringUser);
  void configureDesktopMonitoring(fetchMonitoringConfig, {
    version: app.getVersion(),
    base: url,
    reportsErrors,
  });
}
let headerSession: Session | undefined;
function configureHeaderSession(value: Session | undefined) {
  if (headerSession) headerSession.webRequest.onBeforeSendHeaders(null);
  headerSession = undefined;
  if (
    !value ||
    !desktop.currentSetup?.headers ||
    Object.keys(desktop.currentSetup.headers).length === 0
  )
    return;
  headerSession = value;
  installServerHeaders(
    value,
    () => desktop.currentSetup,
    () => desktop.mainWindow?.webContents.id,
  );
}
async function openAppOnce(targetUrl: string, switching: boolean) {
  desktop.hostComputer?.activate(
    desktop.currentSetup?.mode === "new" && targetUrl === desktop.localStack.webUrl(),
  );
  const target = await resolveSessionForTarget(targetUrl);
  configureHeaderSession(target.value);
  // A failed switch must leave telemetry with the window that remains selected.
  if (desktop.mainWindow === null) activateDesktopMonitoring(targetUrl, target.value);
  const previous = desktop.mainWindow;
  let win: BrowserWindow | null = null;
  try {
    const documentError = await probeDocument(targetUrl);
    if (documentError !== null) throw documentError;
    await installBundledRenderer(
      targetUrl,
      target.value,
      target.partition,
      desktop.currentSetup?.mode === "new",
    );
    const created = createWindow(targetUrl, target.partition);
    win = created.win;
    // On launch the window stays up: the web app shows its own loading, reconnecting or error
    // screen and recovers from it. Switching to a server that is not ready keeps the previous one.
    const state = await created.loaded;
    if (switching && state === "pending") {
      throw withDetail(
        new ServerUnavailable("The server page did not become ready."),
        t("The server page did not become ready."),
      );
    }
    if (switching && state === "failed") {
      throw withDetail(
        new Error("The server page did not become ready."),
        t("The server page did not become ready."),
      );
    }
    desktop.currentTargetUrl = targetUrl;
    activateDesktopMonitoring(targetUrl, target.value);
    desktop.setupError = null;
    // Keep the previous window until the caller commits (after setup.json is written).
    pendingPreviousWindow =
      previous !== null && !previous.isDestroyed() && previous !== win ? previous : null;
    if (pendingPreviousWindow !== null) pendingPreviousWindow.hide();
    return true;
  } catch (error) {
    const closed = win?.isDestroyed() === true;
    if (!closed && !(error instanceof ServerUnavailable)) {
      reportDesktopError(error, "desktop.startup");
    }
    pendingPreviousWindow = null;
    // Keep the previous app window so Cancel / close can restore it.
    if (previous !== null && !previous.isDestroyed()) desktop.mainWindow = previous;
    // Closing the window while it loads is the user leaving, not a failure to explain.
    if (closed) return false;
    // Show the setup window BEFORE destroying the failed one: on Windows/Linux,
    // destroying the last window fires "window-all-closed" -> app.quit() before
    // showSetupWindow() runs, so the app silently exits instead of showing this error.
    showSetupWindow(
      t("Could not open that server. {detail}", { detail: openFailureDetail(error) }),
    );
    if (win !== null && !win.isDestroyed()) win.destroy();
    return false;
  }
}
function syncHostComputerAccess() {
  desktop.hostComputer?.activate(
    desktop.currentSetup?.mode === "new" &&
      desktop.mainWindow !== null &&
      !desktop.mainWindow.isDestroyed() &&
      appWindowTargets.get(desktop.mainWindow) === desktop.localStack.webUrl(),
  );
  void desktop.userDevices?.select(remoteServerOrigin()).catch(() => undefined);
  installApplicationMenu();
}
/** The trust boundary: only a click on Allow here lets bots use this computer. */
async function confirmComputerAccess(detail: string) {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: t("Allow local computer access?"),
    message: t("Allow bots to use this computer?"),
    detail,
    buttons: [t("Cancel"), t("Allow")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win =
    desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed() ? desktop.mainWindow : null;
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return result.response === 1;
}
/** A bot asks while the person may be elsewhere, so bring the prompt to them. */
function confirmRemoteComputerAccess(host: string) {
  if (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()) {
    if (!desktop.mainWindow.isVisible()) desktop.mainWindow.show();
    else if (!desktop.mainWindow.isFocused()) app.dock?.bounce("informational");
  }
  return confirmComputerAccess(
    t(
      "Bots on {host} can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access in Settings.",
      { host },
    ),
  );
}
function deviceTokenCipher() {
  return {
    // Linux without a keyring falls back to a fixed key; keep the token off disk there.
    available: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (value: string) => safeStorage.encryptStringAsync(value),
    decrypt: async (value: Buffer) => (await safeStorage.decryptStringAsync(value)).result,
  };
}
/** Drop the previous app window after the new server is opened and persisted. */
function commitPendingAppSwitch() {
  syncHostComputerAccess();
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed() && previous !== desktop.mainWindow)
    previous.destroy();
}
/**
 * Undo an open that could not be persisted. When a prior session exists, restore
 * it. On first run keep the connected window so the user can retry save.
 */
function abandonPendingAppSwitch(
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): "restored" | "kept" {
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed()) {
    const failed = desktop.mainWindow;
    if (failed !== null && !failed.isDestroyed() && failed !== previous) failed.destroy();
    desktop.mainWindow = previous;
    desktop.currentSetup = previousSetup;
    configureHeaderSession(desktop.mainWindow?.webContents.session);
    desktop.currentTargetUrl = previousUrl;
    activateDesktopMonitoring(previousUrl ?? undefined, previous.webContents.session);
    syncHostComputerAccess();
    // If setup was already closed (e.g. during a slow write), make the restored
    // session visible — otherwise macOS can be left with no shown window.
    if (desktop.setupWindow === null || desktop.setupWindow.isDestroyed()) {
      clearTimeout(desktop.warmWindowTimer);
      previous.show();
      previous.focus();
    }
    return "restored";
  }
  return "kept";
}
/** Best-effort restore of setup.json after a failed save that already wrote disk. */
async function rollbackSetupFile(userDataDir: string, previousSetup: DesktopSetup | null) {
  try {
    if (previousSetup !== null) await writeSetup(userDataDir, previousSetup);
    else await clearSetup(userDataDir);
  } catch {
    // Disk rollback is best-effort; callers already restored in-memory state when possible.
  }
}
/**
 * After a renderer crash around save: restore prior setup when possible, otherwise
 * drop the crashed first-run window so setup remains the only recovery surface.
 */
async function recoverFromCrashedSave(
  userDataDir: string,
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): Promise<string> {
  const outcome = abandonPendingAppSwitch(previousSetup, previousUrl);
  await rollbackSetupFile(userDataDir, previousSetup);
  if (outcome === "kept") {
    if (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed())
      desktop.mainWindow.destroy();
    desktop.mainWindow = null;
    desktop.currentSetup = previousSetup;
    configureHeaderSession(undefined);
    desktop.currentTargetUrl = previousUrl;
    if (previousUrl) {
      const restored = await resolveSessionForTarget(previousUrl);
      activateDesktopMonitoring(previousUrl, restored.value);
    } else activateDesktopMonitoring(undefined);
  }
  const message =
    previousSetup !== null
      ? t(
          "Could not open that server. Renderer stopped. The previous instance was restored for the next launch.",
        )
      : t("Could not open that server. Renderer stopped.");
  showSetupWindow(message);
  return message;
}
// A second launch on Linux/Windows would rerun host-computer setup, overwrite
// the saved token and restart the local stack under the running instance.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = secondInstanceWindow(desktop.setupWindow, desktop.mainWindow);
    if (win === null) return;
    revealSecondInstanceWindow(win);
  });
}
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  installSessionPermissions(session.defaultSession, permissionTarget);
  const userDataDir = app.getPath("userData");
  startDesktopLocale(
    await readUiLocale(userDataDir),
    app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
  );
  desktop.desktopUpdater = new DesktopUpdateController(
    updaterEnvironment,
    // Loaded only when a packaged build actually checks for updates.
    async () => {
      const module = await import("electron-updater");
      return (module.default ?? module).autoUpdater as unknown as ElectronAutoUpdater;
    },
    undefined,
    () => {
      desktop.quitting = false;
    },
    process.platform === "linux"
      ? (update) => verifyDownloadedLinuxUpdate(update, (url, signal) => net.fetch(url, { signal }))
      : undefined,
  );
  const screenDriver = screenDriverRelease(process.platform);
  hostScreen =
    screenDriver &&
    createDesktopHostScreen({
      platform: process.platform,
      driver: screenDriverInstaller({
        dir: path.join(userDataDir, "screen-driver", "bin"),
        fetch: (url) => net.fetch(url),
        release: screenDriver,
      }),
      home: path.join(userDataDir, "screen-driver", "home"),
      permissions: {
        isTrustedAccessibilityClient: (prompt) =>
          systemPreferences.isTrustedAccessibilityClient(prompt),
        getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
        requestScreenCapture: () =>
          desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }),
      },
      locked: () => powerMonitor.getSystemIdleState(1) === "locked",
      fitImage: (png, maxDimension) => {
        const image = nativeImage.createFromBuffer(png);
        const { width, height } = image.getSize();
        if (!width || !height) return undefined;
        const fitted = image.resize(
          width >= height ? { width: maxDimension } : { height: maxDimension },
        );
        return { png: fitted.toPNG(), ...fitted.getSize() };
      },
    });
  try {
    desktop.hostComputer = await prepareHostComputer(userDataDir, hostScreen);
  } catch {
    /* Local access fails closed; Docker remains available. */
  }
  desktop.userDevices = createUserDeviceAccess({
    userDataDir,
    cipher: deviceTokenCipher(),
    device: async () => ({
      name: await deviceName(),
      platform:
        process.platform === "win32" || process.platform === "linux" ? process.platform : "darwin",
    }),
    confirm: (host) => confirmRemoteComputerAccess(host),
    // The app window's session carries the sign-in for that server; the token never reaches it.
    fetch: (url, init) =>
      (desktop.mainWindow && !desktop.mainWindow.isDestroyed()
        ? desktop.mainWindow.webContents.session
        : net
      ).fetch(url, {
        ...init,
        bypassCustomProtocolHandlers: true,
      }),
    connect: (origin, token, events) =>
      startUserDeviceClient({
        serverUrl: origin,
        token,
        root: path.join(userDataDir, "computers"),
        screen: hostScreen,
        ...events,
      }),
  });
  desktop.localStack = new LocalStackController({
    hostComputer: desktop.hostComputer?.connection,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    run: runDocker,
    stackDir: stackDir(userDataDir),
    resourceDir: stackResourceDir({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    localWebUrl:
      process.env.RAKAZO_LOCAL_WEB_URL?.trim() ||
      (await readStackWebUrl(stackDir(userDataDir), LOCAL_WEB_URL)),
    imageTag: resolveImageTag({
      version: app.getVersion(),
      packaged: app.isPackaged,
      override: process.env.RAKAZO_IMAGE_TAG,
    }),
    probe: (url, signal, token) => probeManagedStack(url, token, signal),
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    onState: (state) => {
      if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) {
        desktop.setupWindow.webContents.send("desktop.setup.stack.changed", state);
      }
    },
  });
  desktop.currentSetup = await readSetup(userDataDir);
  const target = resolveStartupTarget({
    envUrl: process.env.RAKAZO_WEB_URL,
    saved: desktop.currentSetup,
    forceSetup: process.env.RAKAZO_FORCE_SETUP === "1",
  });
  if (process.env.RAKAZO_PERFORMANCE_CLEAR_CACHE === "1") {
    const cacheSessions = new Set<Session>([session.defaultSession]);
    if (target.kind === "app") {
      cacheSessions.add((await resolveSessionForTarget(target.url)).value);
    }
    await Promise.all(
      [...cacheSessions].flatMap((value) => [value.clearCache(), value.clearCodeCaches({})]),
    );
    markOnce("rk:main:caches-cleared");
  }

  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  installApplicationMenu();
  const browserAuthAttempts = new Map<string, AbortController>();
  const cancelBrowserAuth = () => {
    for (const attempt of browserAuthAttempts.values()) attempt.abort();
    browserAuthAttempts.clear();
  };
  app.on("before-quit", cancelBrowserAuth);
  ipcMain.handle("desktop.oauth.open", async (event, url: unknown) => {
    if (!fromAppFrame(permissionTarget(), event) || typeof url !== "string" || url.length > 16_384)
      throw new Error("Invalid sign-in request.");
    if (browserAuthAttempts.has(url) || browserAuthAttempts.size >= 8) {
      throw new Error(t("A sign-in attempt is already active. Cancel it and retry."));
    }
    const controller = new AbortController();
    browserAuthAttempts.set(url, controller);
    const stop = () => controller.abort();
    const expiry = setTimeout(stop, 10 * 60_000);
    expiry.unref();
    event.sender.once("destroyed", stop);
    event.sender.once("did-navigate", stop);
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(expiry);
        event.sender.removeListener("destroyed", stop);
        event.sender.removeListener("did-navigate", stop);
        if (browserAuthAttempts.get(url) === controller) browserAuthAttempts.delete(url);
      },
      { once: true },
    );
    try {
      await openBrowserAuth(url, {
        signal: controller.signal,
        onClose: stop,
        openExternal: (target) => shell.openExternal(target),
        onCallback: (callback) => {
          if (!event.sender.isDestroyed()) event.sender.send("desktop.oauth.callback", callback);
        },
      });
    } catch {
      controller.abort();
      throw new Error(t("Could not open browser sign-in. Close other sign-in attempts and retry."));
    }
  });
  ipcMain.handle("desktop.oauth.cancel", (event, url: unknown) => {
    if (!fromAppFrame(permissionTarget(), event) || typeof url !== "string") return;
    browserAuthAttempts.get(url)?.abort();
  });
  const isManagedComputerRequest = (event: Electron.IpcMainInvokeEvent) =>
    fromMainWindow(event) &&
    event.senderFrame === event.sender.mainFrame &&
    desktop.currentSetup?.mode === "new" &&
    appWindowTargets.get(desktop.mainWindow!) === desktop.localStack.webUrl() &&
    safeOrigin(event.senderFrame.url) === safeOrigin(desktop.localStack.webUrl());
  ipcMain.handle("desktop.computer.requestAccess", async (event) => {
    if (!isManagedComputerRequest(event) || !desktop.hostComputer)
      throw new Error(t("Local computer access requires an app-managed local instance."));
    if (requestingComputerAccess) return false;
    requestingComputerAccess = true;
    try {
      if (!(await desktop.localStack.matchesDesiredStack()) || !isManagedComputerRequest(event))
        return false;
      if (desktop.hostComputer.isEnabled()) {
        await persistHostChoice("this-mac");
        return true;
      }
      const allowed = await confirmComputerAccess(
        t(
          "Bots on this local instance can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access from the app menu.",
        ),
      );
      if (!allowed || !isManagedComputerRequest(event)) return false;
      desktop.hostComputer.activate(true);
      await desktop.hostComputer.grant();
      try {
        await persistHostChoice("this-mac");
      } catch (error) {
        await desktop.hostComputer.revoke();
        throw error;
      }
      installApplicationMenu();
      return desktop.hostComputer.isEnabled();
    } finally {
      requestingComputerAccess = false;
    }
  });
  ipcMain.handle("desktop.computer.revokeAccess", async (event) => {
    if (isManagedComputerRequest(event)) await revokeLocalComputerAccess();
  });
  /** The remote server's own page in the app window, never a frame or another window. */
  const remoteDeviceOrigin = (event: Electron.IpcMainInvokeEvent) => {
    const origin = remoteServerOrigin();
    return fromMainWindow(event) &&
      event.senderFrame === event.sender.mainFrame &&
      origin !== null &&
      safeOrigin(event.senderFrame.url) === origin
      ? origin
      : null;
  };
  const deviceState = async (origin: string | null): Promise<RakazoDesktopDevice | null> => {
    const state = origin === null ? null : desktop.userDevices?.state(origin);
    return state ? { ...state, name: await deviceName() } : null;
  };
  ipcMain.handle("desktop.device.state", (event) => deviceState(remoteDeviceOrigin(event)));
  ipcMain.handle("desktop.device.setAllowed", async (event, allowed: unknown) => {
    const origin = remoteDeviceOrigin(event);
    if (origin === null || typeof allowed !== "boolean") return null;
    await desktop.userDevices?.setAllowed(origin, allowed);
    return deviceState(remoteDeviceOrigin(event));
  });
  ipcMain.handle(
    "desktop.locale.set",
    createLocaleHandler(
      permissionTarget,
      (locale) => writeUiLocale(userDataDir, locale),
      installApplicationMenu,
    ),
  );
  ipcMain.handle(
    "desktop.badge.set",
    createBadgeHandler(permissionTarget, (count) => app.setBadgeCount(count)),
  );
  if (process.platform === "darwin") {
    // Installed builds ship the helper as an extra resource; `pnpm build` compiles it for development.
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, "speech", "rakazo-speech")
      : path.join(app.getAppPath(), "build", "speech", "rakazo-speech");
    const speech = createSystemSpeech(permissionTarget, (language) =>
      spawn(helper, [language], { stdio: "pipe" }),
    );
    ipcMain.handle("desktop.speech.start", (event, language: unknown, session: unknown) =>
      speech.start(event, language, session),
    );
    ipcMain.handle("desktop.speech.stop", (event, session: unknown) => speech.stop(event, session));
    ipcMain.handle("desktop.speech.abort", (event, session: unknown) =>
      speech.abort(event, session),
    );
  }
  ipcMain.handle("desktop.platform", () => process.platform);
  ipcMain.handle("desktop.passkeys.rpIds", () => passkeyRpIds);
  ipcMain.handle("desktop.monitoring.enabled", () => reportsErrors);
  handleOnlyFrom(fromMainWindow, "desktop.server.change", () => {
    showSetupWindow();
  });
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
  ipcMain.handle("desktop.update.state", () => desktop.desktopUpdater.state());
  ipcMain.handle("desktop.update.check", (event) =>
    fromAppFrame(permissionTarget(), event)
      ? desktop.desktopUpdater.check(true)
      : desktop.desktopUpdater.state(),
  );
  ipcMain.handle("desktop.update.download", (event) =>
    fromAppFrame(permissionTarget(), event)
      ? desktop.desktopUpdater.download()
      : desktop.desktopUpdater.state(),
  );
  ipcMain.handle("desktop.update.install", (event) =>
    fromAppFrame(permissionTarget(), event) ? installUpdate() : desktop.desktopUpdater.state(),
  );
  registerSetupIpc({
    userDataDir,
    appOpener,
    probeServer,
    configureHeaderSession,
    syncHostComputerAccess,
    commitPendingAppSwitch,
    abandonPendingAppSwitch,
    recoverFromCrashedSave,
  });

  // Register before startup awaits so macOS dock clicks during probe/open are handled.
  app.on("activate", () => {
    if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) {
      desktop.setupWindow.show();
      desktop.setupWindow.focus();
      return;
    }
    if (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()) {
      clearTimeout(desktop.warmWindowTimer);
      desktop.mainWindow.show();
      desktop.mainWindow.focus();
      return;
    }
    if (appOpener.busy()) return;
    if (desktop.currentTargetUrl === null) showSetupWindow(desktop.setupError);
    else
      void appOpener.open(desktop.currentTargetUrl).then((opened) => {
        if (opened) commitPendingAppSwitch();
      });
  });

  if (target.kind === "setup") {
    showSetupWindow();
  } else if (target.source === "saved" && desktop.currentSetup?.mode === "new") {
    const managedUrl = managedLocalOpenUrl(target.url, desktop.localStack.webUrl());
    const managedStackReady =
      managedUrl !== null ? await desktop.localStack.matchesDesiredStack() : false;
    if (managedStackReady && managedUrl !== null) {
      if (await appOpener.open(managedUrl)) {
        commitPendingAppSwitch();
        destroySetupWindow();
      }
    } else {
      // Missing, stale, foreign, or owned by another process: reconcile the
      // app-managed stack before any API or computer traffic is allowed.
      void desktop.localStack.start();
      showSetupWindow();
    }
  } else if (target.source !== "env") {
    const reachability = await probeServer(target.url, undefined, desktop.currentSetup?.headers);
    if (reachability.ok) {
      if (await appOpener.open(target.url)) {
        commitPendingAppSwitch();
        destroySetupWindow();
      }
    } else {
      // An unreachable first-launch Cloud lands in setup, where the other servers are.
      showSetupWindow(
        target.source === "saved"
          ? t("Could not reconnect to the saved server. {detail}", {
              detail: reachability.error ?? "",
            })
          : (reachability.error ?? null),
      );
    }
  } else {
    if (await appOpener.open(target.url)) {
      commitPendingAppSwitch();
      destroySetupWindow();
    }
  }
});
app.on("window-all-closed", () => {
  // A hidden session probe (defaultSessionHasOriginData) can be the only window
  // during startup; its teardown must not quit the app.
  if (desktop.liveProbeWindows > 0) return;
  if (process.platform !== "darwin") app.quit();
});
app.on("quit", (_event, exitCode) => {
  if (exitCode === 0) desktop.desktopUpdater?.installOnQuit();
});
app.on("before-quit", () => {
  desktop.quitting = true;
  clearTimeout(desktop.warmWindowTimer);
  // Containers keep running; only an in-flight pull/up is cut short.
  desktop.hostComputer?.activate(false);
  void desktop.hostComputer?.close();
  desktop.userDevices?.close();
  void hostScreen?.close();
  desktop.localStack?.abort();
});
