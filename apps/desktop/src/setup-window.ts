import path from "node:path";
import type { DesktopReachability, DesktopSetup } from "@rakazo/contracts";
import { parseServerHeaders } from "@rakazo/contracts";
import type { Session } from "electron";
import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import type { createAppOpener } from "./app-opener.js";
import { developmentIcon, handleOnlyFrom, markOnce } from "./app-window.js";
import { desktop } from "./desktop-state.js";
import { DOCKER_INSTALL_LINKS, isDesktopSetupLink } from "./docker-cli.js";
import { desktopDirection, desktopLocale, desktopMessages, t } from "./i18n.js";
import { managedLocalOpenUrl, parseSetupInput, RAKAZO_CLOUD_URL } from "./setup-config.js";
import { writeSetup } from "./setup-store.js";
import { setupWindowOptions } from "./window-options.js";

let setupSaveInProgress = false;
function createSetupWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...setupWindowOptions(process.platform, screen.getPrimaryDisplay().workAreaSize),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "setup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A long pull runs while this window sits behind others; throttled timers would freeze it.
      backgroundThrottling: false,
    },
  });
  desktop.setupWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("closed", () => {
    if (desktop.setupWindow === win) desktop.setupWindow = null;
    // Closing setup without saving restores a connected session (Change Server cancel).
    restoreAppWindowAfterSetup();
  });
  void win.loadFile(path.join(import.meta.dirname, "setup.html"));
  markOnce("rk:main:setup-window-created");
  return win;
}
/** Hide the app while setup is open; do not clear the saved target until a new one opens. */
export function showSetupWindow(error: string | null = null) {
  desktop.setupError = error;

  let win: BrowserWindow;
  if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) {
    if (error !== null) desktop.setupWindow.reload();
    win = desktop.setupWindow;
  } else {
    win = createSetupWindow();
  }
  if (desktop.mainWindow !== null && !desktop.mainWindow.isDestroyed()) desktop.mainWindow.hide();
  win.show();
  win.focus();
  return win;
}
function restoreAppWindowAfterSetup() {
  if (desktop.quitting) return;
  if (desktop.setupWindow !== null && !desktop.setupWindow.isDestroyed()) return;
  if (
    desktop.mainWindow === null ||
    desktop.mainWindow.isDestroyed() ||
    desktop.currentTargetUrl === null
  )
    return;
  clearTimeout(desktop.warmWindowTimer);
  desktop.mainWindow.show();
  desktop.mainWindow.focus();
}
/** Setup IPC must only answer the setup window, never a connected Rakazo server. */
function fromSetupWindow(event: Pick<Electron.IpcMainInvokeEvent, "sender">) {
  return (
    desktop.setupWindow !== null &&
    !desktop.setupWindow.isDestroyed() &&
    event.sender === desktop.setupWindow.webContents
  );
}
/** Watch for a renderer crash until setup is persisted (or the switch is abandoned). */
function watchRendererUntilCommitted(win: BrowserWindow) {
  let crashed = false;
  const onGone = () => {
    crashed = true;
  };
  win.webContents.once("render-process-gone", onGone);
  return {
    crashed: () => crashed || (!win.isDestroyed() && win.webContents.isCrashed()),
    dispose: () => {
      if (!win.isDestroyed()) win.webContents.removeListener("render-process-gone", onGone);
    },
  };
}
export function destroySetupWindow() {
  const setup = desktop.setupWindow;
  desktop.setupWindow = null;
  if (setup !== null && !setup.isDestroyed()) setup.destroy();
}
type SetupIpcDeps = {
  userDataDir: string;
  appOpener: ReturnType<typeof createAppOpener>;
  probeServer: (
    rawUrl: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ) => Promise<DesktopReachability>;
  configureHeaderSession: (value: Session | undefined) => void;
  syncHostComputerAccess: () => void;
  commitPendingAppSwitch: () => void;
  abandonPendingAppSwitch: (
    previousSetup: DesktopSetup | null,
    previousUrl: string | null,
  ) => "restored" | "kept";
  recoverFromCrashedSave: (
    userDataDir: string,
    previousSetup: DesktopSetup | null,
    previousUrl: string | null,
  ) => Promise<string>;
};

const SETUP_NOT_ACTIVE = () => ({ ok: false, error: "Setup is not active." });

/** The setup window's IPC. Every channel answers the setup window only. */
export function registerSetupIpc({
  userDataDir,
  appOpener,
  probeServer,
  configureHeaderSession,
  syncHostComputerAccess,
  commitPendingAppSwitch,
  abandonPendingAppSwitch,
  recoverFromCrashedSave,
}: SetupIpcDeps) {
  // Synchronous so the setup page has its language before it first paints.
  ipcMain.on("desktop.setup.locale", (event) => {
    event.returnValue = fromSetupWindow(event)
      ? { lang: desktopLocale(), dir: desktopDirection(), messages: desktopMessages() }
      : null;
  });
  handleOnlyFrom(
    fromSetupWindow,
    "desktop.setup.state",
    () => ({
      defaultLocalUrl: desktop.localStack.webUrl(),
      cloudUrl: RAKAZO_CLOUD_URL,
      saved: desktop.currentSetup,
      error: desktop.setupError ?? undefined,
    }),
    () => null,
  );

  handleOnlyFrom(
    fromSetupWindow,
    "desktop.setup.test",
    async (_event, url: unknown, headers: unknown) => {
      if (typeof url !== "string") return { ok: false, error: t("Enter a server address.") };
      const parsedHeaders = parseServerHeaders(headers ?? {});
      if (parsedHeaders === null) return { ok: false, error: t("Invalid custom headers") };
      return probeServer(url, undefined, parsedHeaders);
    },
    SETUP_NOT_ACTIVE,
  );

  handleOnlyFrom(
    fromSetupWindow,
    "desktop.setup.save",
    async (_event, payload: unknown) => {
      // A launch still loading counts too: the switch must open and check its own server.
      if (setupSaveInProgress || appOpener.busy())
        return { ok: false, error: t("A connection attempt is already running.") };
      setupSaveInProgress = true;
      const previousSetup = desktop.currentSetup;
      const previousUrl = desktop.currentTargetUrl;
      try {
        const setup = parseSetupInput(payload);
        if (setup === null) {
          return {
            ok: false,
            error: t(
              "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.",
            ),
          };
        }

        // Only open the exact origin selected and authenticated by the managed stack.
        let openSetup = setup;
        if (setup.mode === "new") {
          const managedUrl = managedLocalOpenUrl(setup.serverUrl, desktop.localStack.webUrl());
          if (managedUrl === null || !(await desktop.localStack.matchesDesiredStack())) {
            return {
              ok: false,
              error: t("The app-managed Rakazo services are not ready. Retry setup."),
            };
          }
          openSetup = { mode: "new", serverUrl: managedUrl };
        }

        const reachability = await probeServer(openSetup.serverUrl, undefined, openSetup.headers);
        if (!reachability.ok) return { ok: false, error: reachability.error };

        // Open before persisting so a failed renderer load keeps the last working setup.
        desktop.currentSetup = openSetup;
        const opened = await appOpener.open(openSetup.serverUrl, { switching: true });
        if (!opened) {
          desktop.currentSetup = previousSetup;
          configureHeaderSession(desktop.mainWindow?.webContents.session);
          syncHostComputerAccess();
          return {
            ok: false,
            error: t("Could not open that server. The previous instance was left unchanged."),
          };
        }

        const appWindow = desktop.mainWindow;
        const rendererWatch =
          appWindow !== null && !appWindow.isDestroyed()
            ? watchRendererUntilCommitted(appWindow)
            : null;
        try {
          await writeSetup(userDataDir, openSetup);
          if (rendererWatch?.crashed()) {
            const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
            return { ok: false, error: message };
          }
          // Commit while the crash listener is still armed.
          commitPendingAppSwitch();
          if (rendererWatch?.crashed()) {
            const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
            return { ok: false, error: message };
          }
          destroySetupWindow();
          // Final check after setup closes — a crash in this gap still rolls back.
          if (rendererWatch?.crashed()) {
            const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
            return { ok: false, error: message };
          }
          return { ok: true };
        } catch {
          const outcome = abandonPendingAppSwitch(previousSetup, previousUrl);
          return {
            ok: false,
            error:
              outcome === "restored"
                ? t("Could not save setup. The previous instance was restored.")
                : t("Connected, but could not save setup for the next launch. Try Continue again."),
          };
        } finally {
          rendererWatch?.dispose();
        }
      } finally {
        setupSaveInProgress = false;
      }
    },
    SETUP_NOT_ACTIVE,
  );

  handleOnlyFrom(fromSetupWindow, "desktop.setup.quit", () => {
    app.quit();
  });
  handleOnlyFrom(fromSetupWindow, "desktop.setup.openLink", async (_event, link: unknown) => {
    if (!isDesktopSetupLink(link)) return;
    await shell.openExternal(DOCKER_INSTALL_LINKS[link]);
  });
  handleOnlyFrom(
    fromSetupWindow,
    "desktop.setup.stack.state",
    () => desktop.localStack.state(),
    () => null,
  );
  handleOnlyFrom(
    fromSetupWindow,
    "desktop.setup.stack.start",
    () => {
      // Respond right away; the setup window polls `stack.state` until a terminal phase.
      void desktop.localStack.start();
      return desktop.localStack.state();
    },
    () => null,
  );
}
