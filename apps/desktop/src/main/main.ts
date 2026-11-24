import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostScreen } from "@rakazo/adapters/host-screen";
import { startUserDeviceClient } from "@rakazo/adapters/user-device-client";
import type {
  DesktopLocalStackState,
  DesktopReachability,
  DesktopSetup,
  RakazoDesktopDevice,
} from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import type { Session } from "electron";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  nativeImage,
  net,
  powerMonitor,
  session,
  shell,
  systemPreferences,
} from "electron";
import { createBrowserAuthHandlers } from "./auth/browser-auth.js";
import { chooseLinuxKeyring, deviceTokenCipher } from "./auth/device-token-cipher.js";
import { associatedPasskeyRpIds } from "./auth/passkeys.js";
import { installSessionPermissions } from "./auth/session-permissions.js";
import { createUserDeviceAccess, deviceName } from "./auth/user-device.js";
import { appWindowTargets, desktop, permissionTarget } from "./desktop-state.js";
import { createLocaleHandler, errorDetail, startDesktopLocale, t, withDetail } from "./i18n.js";
import type { IpcCaller } from "./ipc/ipc.js";
import { handleIpc, sentFrom } from "./ipc/ipc.js";
import { installServerHeaders } from "./setup/server-request-headers.js";
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
} from "./setup/setup-config.js";
import {
  clearSetup,
  readSetup,
  readUiLocale,
  writeSetup,
  writeUiLocale,
} from "./setup/setup-store.js";
import {
  destroySetupWindow,
  isSetupSaveInProgress,
  registerSetupIpc,
  showSetupWindow,
} from "./setup/setup-window.js";
import { createBadgeHandler } from "./system/badge.js";
import { createClipboardHandler } from "./system/clipboard.js";
import {
  configureDesktopMonitoring,
  desktopReportsErrors,
  disableDesktopMonitoring,
  installDesktopEarlyErrorReporting,
  refreshDesktopMonitoringUser,
  reportDesktopError,
} from "./system/monitoring.js";
import { createSystemSpeech } from "./system/system-speech.js";
import {
  confirmRemoteComputerAccess,
  createComputerAccessHandler,
  isManagedComputerRequest,
} from "./this-computer/computer-access.js";
import {
  createComputerPermissionSetup,
  waitForComputerSetupReturn,
} from "./this-computer/computer-permissions.js";
import { launchDockerApp, resolveDockerBinary, runDocker } from "./this-computer/docker-cli.js";
import type { StackChoice } from "./this-computer/docker-move.js";
import {
  chooseStack,
  dockerRunning,
  moveAccepted,
  moveDockerStack,
  readStackChoice,
  settleStackWhenNeeded,
  stackExists,
  writeStackChoice,
} from "./this-computer/docker-move.js";
import { prepareHostComputer } from "./this-computer/host-computer.js";
import type { ScreenPermissionApi } from "./this-computer/host-screen.js";
import {
  createDesktopHostScreen,
  screenDriverInstaller,
  screenDriverRelease,
} from "./this-computer/host-screen.js";
import {
  createLocalComputerChoice,
  saveLocalComputerHost,
} from "./this-computer/local-settings.js";
import { syncLocalSignup } from "./this-computer/local-signup.js";
import {
  defaultSleep,
  LocalStackController,
  readStackToken,
  readStackWebUrl,
  resolveImageTag,
  stackDir,
  stackResourceDir,
} from "./this-computer/local-stack.js";
import type { ServerBundle } from "./this-computer/mac-runtime.js";
import { nativeStackEligible, readServerBundle } from "./this-computer/mac-runtime.js";
import { NativeStackController } from "./this-computer/native-stack.js";
import {
  StackStopMenuAvailability,
  stopStackLeftBehind,
} from "./this-computer/stop-local-stack.js";
import type { ElectronAutoUpdater } from "./updates/auto-update.js";
import { DesktopUpdateController } from "./updates/auto-update.js";
import { installedBundleVersion } from "./updates/installed-version.js";
import { verifyDownloadedLinuxUpdate } from "./updates/linux-update-signature.js";
import { applicationMenuInstaller, followUpdateState, installUpdate } from "./windows/app-menu.js";
import { createAppOpener } from "./windows/app-opener.js";
import {
  createWindow,
  developmentIcon,
  installBundledRenderer,
  markOnce,
  PROBE_TIMEOUT_MS,
  probeDocument,
  remoteServerOrigin,
  resolveSessionForTarget,
  ServerUnavailable,
} from "./windows/app-window.js";
import { DEEP_LINK_SCHEME } from "./windows/deep-link.js";
import { registerDeepLinkHandlers } from "./windows/second-instance.js";
import { registerWindowControls } from "./windows/window-controls.js";
import { isMcpOAuthServerId, mcpOAuthPartition } from "./windows/window-open.js";

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
const reportsErrors = desktopReportsErrors(app.isPackaged);
const updaterEnvironment = {
  // A `--dir` build has no update feed to read.
  packaged: app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml")),
  version: app.getVersion(),
  disabled: process.env.RAKAZO_DISABLE_AUTO_UPDATE === "1",
  installedVersion: process.platform === "darwin" ? installedBundleVersion : undefined,
};
let hostScreen: HostScreen | undefined;
markOnce("rk:main:module-evaluated");
chooseLinuxKeyring();
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
/**
 * Asked once, and only of someone running This computer on Docker while Docker answers: a
 * declined offer is remembered; an accepted one moves the data when the stack next starts.
 */
async function offerDockerMove(userStackDir: string): Promise<StackChoice> {
  if (
    !(await dockerRunning({
      stackDir: userStackDir,
      platform: process.platform,
      env: process.env,
      exists: existsSync,
      run: runDocker,
    }))
  )
    return "docker";
  const options: Electron.MessageBoxOptions = {
    type: "question",
    message: t("Run Rakazo without Docker?"),
    detail: t("Your bots and data move over. Docker is stopped, not removed."),
    buttons: [t("Move"), t("Keep Docker")],
    defaultId: 0,
    cancelId: 1,
  };
  // Asked from setup, the sheet keeps setup from moving on until it is answered.
  const setup =
    desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed() ? desktop.setupWindow : null;
  const { response } = await (setup
    ? dialog.showMessageBox(setup, options)
    : dialog.showMessageBox(options));
  const choice = response === 0 ? "native" : "docker";
  try {
    await writeStackChoice(userStackDir, choice);
  } catch (error) {
    // A move that cannot be remembered would be offered again mid-way; stay on Docker for now.
    reportDesktopError(error, "desktop.startup");
    return "docker";
  }
  return choice;
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
async function allowLocalSignupIn(value: Session, managedLocal: boolean) {
  const token = managedLocal ? await readStackToken(stackDir(app.getPath("userData"))) : null;
  await syncLocalSignup(value, desktop.localStack.webUrl(), token);
}
/** Opening another server removed the cookie from a session it may share with this window. */
function restoreLocalSignup(window: BrowserWindow) {
  if (appWindowTargets.get(window) !== desktop.localStack.webUrl()) return;
  void bestEffort(
    "restore the local signup cookie",
    allowLocalSignupIn(window.webContents.session, true),
  );
}
async function openAppOnce(targetUrl: string, switching: boolean) {
  const managedLocal =
    desktop.currentSetup?.mode === "new" && targetUrl === desktop.localStack.webUrl();
  desktop.hostComputer?.activate(managedLocal);
  const target = await resolveSessionForTarget(targetUrl);
  configureHeaderSession(target.value);
  // A failed switch must leave telemetry with the window that remains selected.
  if (desktop.mainWindow === null) activateDesktopMonitoring(targetUrl, target.value);
  const previous = desktop.mainWindow;
  let win: BrowserWindow | null = null;
  try {
    await allowLocalSignupIn(target.value, managedLocal);
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
    // Kept until the caller commits (after setup.json is written) or the switch is abandoned.
    desktop.replacedAppWindow =
      previous !== null && !previous.isDestroyed() && previous !== win ? previous : null;
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
    if (desktop.replacedAppWindow !== null && !desktop.replacedAppWindow.isDestroyed())
      desktop.replacedAppWindow.hide();
    return true;
  } catch (error) {
    const closed = win?.isDestroyed() === true;
    if (!closed && !(error instanceof ServerUnavailable)) {
      reportDesktopError(error, "desktop.startup");
    }
    desktop.replacedAppWindow = null;
    // Keep the previous app window so Cancel / close can restore it.
    if (previous !== null && !previous.isDestroyed()) {
      desktop.mainWindow = previous;
      restoreLocalSignup(previous);
    }
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
/** Drop the previous app window after the new server is opened and persisted. */
function commitPendingAppSwitch() {
  syncHostComputerAccess();
  const previous = desktop.replacedAppWindow;
  desktop.replacedAppWindow = null;
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
  const previous = desktop.replacedAppWindow;
  desktop.replacedAppWindow = null;
  if (previous !== null && !previous.isDestroyed()) {
    const failed = desktop.mainWindow;
    if (failed !== null && !failed.isDestroyed() && failed !== previous) failed.destroy();
    desktop.mainWindow = previous;
    desktop.currentSetup = previousSetup;
    configureHeaderSession(desktop.mainWindow?.webContents.session);
    restoreLocalSignup(previous);
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
function reopenAppWindow() {
  if (desktop.currentTargetUrl === null) {
    showSetupWindow(desktop.setupError);
    return;
  }
  void appOpener.open(desktop.currentTargetUrl).then((opened) => {
    if (!opened) return;
    commitPendingAppSwitch();
    deepLinks?.applyPending();
  });
}

// A second launch on Linux/Windows would rerun host-computer setup, overwrite
// the saved token and restart the local stack under the running instance.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const deepLinks = hasSingleInstanceLock
  ? registerDeepLinkHandlers(app, {
      initialArgv: process.argv,
      isOpening: () => appOpener.busy() || isSetupSaveInProgress(),
      reopen: reopenAppWindow,
    })
  : undefined;
if (!hasSingleInstanceLock) app.quit();
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
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
  followUpdateState(() => installApplicationMenu());
  const screenDriver = screenDriverRelease(process.platform);
  const screenPermissions: ScreenPermissionApi = {
    isTrustedAccessibilityClient: (prompt) =>
      systemPreferences.isTrustedAccessibilityClient(prompt),
    getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
    requestScreenCapture: () =>
      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }),
  };
  const prepareComputerAccess = createComputerPermissionSetup({
    platform: process.platform,
    permissions: screenPermissions,
    showSetup: async (readyForRestart) => {
      const options: Electron.MessageBoxOptions = {
        type: "info",
        title: t("Mac app control"),
        message: readyForRestart
          ? t("Restart Rakazo to finish setup")
          : t("Set up Mac app control"),
        detail: readyForRestart
          ? undefined
          : t(
              "Commands already work. To use apps, allow Accessibility and Screen Recording for Rakazo in System Settings, then restart Rakazo.",
            ),
        buttons: readyForRestart
          ? [t("Restart Rakazo"), t("Not Now")]
          : [t("Open System Settings"), t("Restart Rakazo"), t("Not Now")],
        defaultId: 0,
        cancelId: readyForRestart ? 1 : 2,
        noLink: true,
      };
      const win = desktop.mainWindow;
      const { response } = await (win && !win.isDestroyed()
        ? dialog.showMessageBox(win, options)
        : dialog.showMessageBox(options));
      if (readyForRestart) return response === 0 ? "restart" : "later";
      return response === 0 ? "settings" : response === 1 ? "restart" : "later";
    },
    openSettings: () =>
      waitForComputerSetupReturn(app, () =>
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security"),
      ),
    restart: () => {
      desktop.quitting = true;
      app.relaunch();
      app.quit();
    },
  });
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
      permissions: screenPermissions,
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
  desktop.userDevices = createUserDeviceAccess({
    userDataDir,
    cipher: deviceTokenCipher(),
    device: async () => ({
      name: await deviceName(),
      platform:
        process.platform === "win32" || process.platform === "linux" ? process.platform : "darwin",
    }),
    confirm: (host) => confirmRemoteComputerAccess(host),
    prepareAccess: prepareComputerAccess,
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
  desktop.currentSetup = await readSetup(userDataDir);
  const userStackDir = stackDir(userDataDir);
  const resourceDir = stackResourceDir({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const localWebUrl =
    process.env.RAKAZO_LOCAL_WEB_URL?.trim() ||
    (await readStackWebUrl(userStackDir, LOCAL_WEB_URL));
  const imageTag = resolveImageTag({
    version: app.getVersion(),
    packaged: app.isPackaged,
    override: process.env.RAKAZO_IMAGE_TAG,
  });
  const probe = (url: string, signal: AbortSignal, token: string) =>
    probeManagedStack(url, token, signal);
  const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");
  // Must exist before the stack controller: its lifecycle transitions refresh the stop item.
  const stopStackMenu = new StackStopMenuAvailability(() => installApplicationMenu());
  const onState = (state: DesktopLocalStackState) => {
    if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) {
      desktop.setupWindow.webContents.send("desktop.setup.stack.changed", state);
    }
    // A stack can start or stop without a server switch; its phase transitions refresh
    // the stop item.
    stopStackMenu.stackChanged(state.phase);
  };
  const serverBundle = nativeStackEligible({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
  })
    ? await readServerBundle({
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
        override: process.env.RAKAZO_SERVER_BUNDLE,
      })
    : null;
  // Read again when the choice is settled later: Docker or either stack may have changed since.
  const stackFacts = async () => ({
    ...stackExists(userStackDir, existsSync),
    // Installed but not running keeps the Docker path; no Docker at all leaves nothing to keep.
    dockerInstalled: resolveDockerBinary(process.platform, process.env, existsSync) !== null,
    choice: await readStackChoice(userStackDir),
  });
  const decideStack = async () =>
    chooseStack({ eligible: serverBundle !== null, ...(await stackFacts()) });
  const choice = await decideStack();
  const moveDeps = {
    stackDir: userStackDir,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    run: runDocker,
    sleep: defaultSleep,
  };
  const stackDeps = {
    stackDir: userStackDir,
    resourceDir,
    localWebUrl,
    imageTag,
    run: runDocker,
    exists: existsSync,
    probe,
    randomHex,
    onState,
  };
  const nativeStack = (bundle: ServerBundle, moving: boolean) =>
    new NativeStackController({
      ...stackDeps,
      hostComputer: desktop.hostComputer?.connection,
      serverBundle: bundle,
      nodeBinary: process.execPath,
      env: process.env,
      uid: process.getuid?.() ?? 0,
      fetch: (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
      importFromDocker: moving ? (target) => moveDockerStack(moveDeps, target) : undefined,
    });
  const dockerStack = () =>
    new LocalStackController({
      ...stackDeps,
      hostComputer: desktop.hostComputer?.connection,
      platform: process.platform,
      env: process.env,
      launchDockerApp: (binary) => launchDockerApp(process.platform, binary),
      // A confirmed reuse changes no phase; the menu must hear about it separately.
      onReuseConfirmed: () => stopStackMenu.reuseConfirmed(),
    });
  const useStack = async (selected: StackChoice) => {
    const bundle = selected === "native" ? serverBundle : null;
    const moving = bundle !== null && moveAccepted(await stackFacts());
    // The stack can still run with local computer access disabled.
    desktop.hostComputer = await bestEffort(
      "start the desktop computer bridge",
      prepareHostComputer(userDataDir, bundle === null ? "docker" : "native", hostScreen),
    );
    desktop.localStack = bundle === null ? dockerStack() : nativeStack(bundle, moving);
  };
  // Setup can read the Docker controller's idle state while the move choice is pending.
  // Opening or starting the local stack waits for that choice before preparing the bridge.
  if (choice === "ask") desktop.localStack = dockerStack();
  else await useStack(choice);
  const settleLocalStack = settleStackWhenNeeded(
    choice,
    async () => {
      const settled = await decideStack();
      return settled === "ask" ? offerDockerMove(userStackDir) : settled;
    },
    useStack,
  );
  if (desktop.currentSetup?.mode === "new") await settleLocalStack();
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
  const browserAuth = createBrowserAuthHandlers((target) => shell.openExternal(target));
  app.on("before-quit", browserAuth.cancelAll);
  handleIpc("desktop.oauth.open", browserAuth.open);
  handleIpc("desktop.oauth.cancel", browserAuth.cancel);
  // Signing an MCP server in again with another account starts from an empty
  // browser: no cookies, no cached login pages, no stored site data.
  handleIpc("desktop.mcpBrowser.clear", async (_event, serverId) => {
    const target = permissionTarget();
    if (!target || !isMcpOAuthServerId(serverId))
      throw new Error("Invalid sign-in browser request.");
    const browser = session.fromPartition(mcpOAuthPartition(target.url, serverId));
    await Promise.all([
      browser.clearStorageData(),
      browser.clearCache(),
      browser.clearAuthCache(),
      browser.clearCodeCaches({}),
    ]);
  });
  handleIpc(
    "desktop.computer.requestAccess",
    createComputerAccessHandler({
      persistHostChoice: () => persistHostChoice("this-mac"),
      installApplicationMenu,
      prepareAccess: prepareComputerAccess,
    }),
  );
  handleIpc("desktop.computer.revokeAccess", async (event) => {
    if (isManagedComputerRequest(event)) await revokeLocalComputerAccess();
  });
  /** The remote server the app window shows; null for the local stack, or once the window moved on. */
  const remoteDeviceOrigin = (event: IpcCaller) =>
    sentFrom("app", event) ? remoteServerOrigin() : null;
  const deviceState = async (origin: string | null): Promise<RakazoDesktopDevice | null> => {
    const state = origin === null ? null : desktop.userDevices?.state(origin);
    return state ? { ...state, name: await deviceName() } : null;
  };
  handleIpc("desktop.device.state", (event) => deviceState(remoteDeviceOrigin(event)));
  handleIpc("desktop.device.setAllowed", async (event, allowed) => {
    const origin = remoteDeviceOrigin(event);
    if (origin === null || typeof allowed !== "boolean") return null;
    await desktop.userDevices?.setAllowed(origin, allowed);
    return deviceState(remoteDeviceOrigin(event));
  });
  handleIpc(
    "desktop.locale.set",
    createLocaleHandler((locale) => writeUiLocale(userDataDir, locale), installApplicationMenu),
  );
  handleIpc(
    "desktop.badge.set",
    createBadgeHandler((count) => app.setBadgeCount(count)),
  );
  if (process.platform === "darwin") {
    // Installed builds ship the helper as an extra resource; `pnpm build` compiles it for development.
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, "speech", "rakazo-speech")
      : path.join(app.getAppPath(), "build", "speech", "rakazo-speech");
    const speech = createSystemSpeech(permissionTarget, (language) =>
      spawn(helper, [language], { stdio: "pipe" }),
    );
    handleIpc("desktop.speech.start", (event, language, session) =>
      speech.start(event, language, session),
    );
    handleIpc("desktop.speech.stop", (event, session) => speech.stop(event, session));
    handleIpc("desktop.speech.abort", (event, session) => speech.abort(event, session));
  }
  handleIpc(
    "desktop.clipboard.write",
    createClipboardHandler(permissionTarget, (text) => clipboard.writeText(text)),
  );
  handleIpc("desktop.passkeys.rpIds", () => passkeyRpIds);
  handleIpc("desktop.monitoring.enabled", () => reportsErrors);
  handleIpc("desktop.server.change", () => {
    showSetupWindow();
  });
  registerWindowControls();
  const updateState = () => desktop.desktopUpdater.state();
  handleIpc("desktop.update.state", updateState, updateState);
  handleIpc("desktop.update.check", () => desktop.desktopUpdater.check(true), updateState);
  handleIpc("desktop.update.download", () => desktop.desktopUpdater.download(), updateState);
  handleIpc("desktop.update.install", () => installUpdate(), updateState);
  registerSetupIpc({
    userDataDir,
    appOpener,
    probeServer,
    configureHeaderSession,
    syncHostComputerAccess,
    commitPendingAppSwitch,
    abandonPendingAppSwitch,
    recoverFromCrashedSave,
    stopStackLeftBehind: (previousMode) =>
      stopStackLeftBehind({
        mode: desktop.currentSetup?.mode,
        serverUrl: desktop.currentSetup?.serverUrl,
        previousMode,
        stack: desktop.localStack,
        rebuildMenu: () => installApplicationMenu(),
      }),
    settleLocalStack,
    onAppReady: () => deepLinks?.applyPending(),
  });

  const openInitialServer = async (url: string) => {
    if (!(await appOpener.open(url))) return;
    commitPendingAppSwitch();
    destroySetupWindow();
  };

  // Register before startup awaits so macOS dock clicks during probe/open are handled.
  deepLinks?.registerActivate();

  if (target.kind === "setup") {
    showSetupWindow();
  } else if (target.source === "saved" && desktop.currentSetup?.mode === "new") {
    const managedUrl = managedLocalOpenUrl(target.url, desktop.localStack.webUrl());
    const managedStackReady =
      managedUrl !== null ? await desktop.localStack.matchesDesiredStack() : false;
    if (managedStackReady && managedUrl !== null) {
      await openInitialServer(managedUrl);
    } else {
      // Missing, stale, foreign, or owned by another process: reconcile the
      // app-managed stack before any API or computer traffic is allowed.
      void desktop.localStack.start();
      showSetupWindow();
    }
  } else if (target.source !== "env") {
    const reachability = await probeServer(target.url, undefined, desktop.currentSetup?.headers);
    if (reachability.ok) {
      await openInitialServer(target.url);
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
    await openInitialServer(target.url);
  }
  deepLinks?.finishStartup();
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
app.on("before-quit", (event) => {
  desktop.quitting = true;
  // A ready update is staged before quitting; the updater quits again once it is.
  const installing = desktop.desktopUpdater?.installBeforeQuit();
  if (installing) {
    event.preventDefault();
    // Staging takes a few seconds; the app should look closed meanwhile.
    for (const window of BrowserWindow.getAllWindows()) window.hide();
    void installing.then(() => app.quit());
    return;
  }
  // Server processes this app runs itself stop with it; quit again once they have.
  if (desktop.localStack instanceof NativeStackController && desktop.localStack.hasProcesses()) {
    event.preventDefault();
    void desktop.localStack.stop().finally(() => app.quit());
    return;
  }
  clearTimeout(desktop.warmWindowTimer);
  // Containers keep running; only an in-flight pull/up is cut short.
  desktop.hostComputer?.activate(false);
  void desktop.hostComputer?.close();
  desktop.userDevices?.close();
  void hostScreen?.close();
  desktop.localStack?.abort();
});
