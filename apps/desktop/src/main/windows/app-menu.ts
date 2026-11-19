import type { DesktopMenuCommand, DesktopUpdateState } from "@rakazo/contracts";
import { app, dialog, Menu } from "electron";
import { desktop } from "../desktop-state.js";
import { desktopLocale, t } from "../i18n.js";
import { showSetupWindow } from "../setup/setup-window.js";
import type { createLocalComputerChoice } from "../this-computer/local-settings.js";
import { quitAndStopBotsItem } from "../this-computer/stop-local-stack.js";
import { updaterSupport } from "../updates/auto-update.js";
import { remoteServerOrigin } from "./app-window.js";

let menuUpdateCheck: Promise<void> | null = null;
/** Works before sign-in, unlike the settings section, and answers with native alerts. */
function checkForUpdatesFromMenu() {
  // One request at a time, so repeated clicks cannot stack alerts.
  menuUpdateCheck ??= runMenuUpdateCheck().finally(() => {
    menuUpdateCheck = null;
  });
  return menuUpdateCheck;
}
async function runMenuUpdateCheck() {
  const alert = (options: Electron.MessageBoxOptions) =>
    desktop.mainWindow && !desktop.mainWindow.isDestroyed()
      ? dialog.showMessageBox(desktop.mainWindow, options)
      : dialog.showMessageBox(options);
  let state = await desktop.desktopUpdater.check(true);
  // A found update starts downloading on its own; wait for it so the answer can be "restart".
  if (state.phase === "available" || state.phase === "downloading") {
    // Say so now: the download can take minutes, and the menu click has no other answer.
    const downloading = alert({
      message: t("Downloading Rakazo {version}…", { version: state.availableVersion ?? "" }),
    });
    state = await desktop.desktopUpdater.download();
    // The result waits for that alert, so the two never show at once.
    await downloading;
  }
  if (state.phase === "ready") {
    const { response } = await alert({
      message: t("Rakazo {version} is ready to install.", {
        version: state.availableVersion ?? "",
      }),
      buttons: [t("Restart"), t("Later")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    const result = await installUpdate();
    if (result.message) {
      await alert({
        type: "warning",
        message: t("Could not install the update."),
        detail: result.message,
      });
    }
  } else if (state.message) {
    // Offline and other failed checks settle back to idle with a message.
    await alert({
      type: "warning",
      message: t("Could not check for updates."),
      detail: state.message,
    });
  } else if (state.phase === "idle") {
    await alert({
      message: t("Rakazo is up to date."),
      detail: t("Version {version}", { version: state.currentVersion }),
    });
  }
}
export async function installUpdate() {
  if (desktop.desktopUpdater.state().phase !== "ready") return desktop.desktopUpdater.state();
  desktop.quitting = true;
  const state = await desktop.desktopUpdater.install();
  // A failed install stays ready for retry but reports a message. Restore normal
  // window behavior while the user keeps working after that failure.
  if (state.phase !== "ready" || state.message !== null) desktop.quitting = false;
  return state;
}
/** Keeps the menu item's label and the Dock or taskbar progress bar in step with the updater. */
export function followUpdateState(rebuildMenu: () => void) {
  let phase = desktop.desktopUpdater.state().phase;
  return desktop.desktopUpdater.subscribe((state) => {
    const window = desktop.mainWindow;
    if (window && !window.isDestroyed()) {
      window.setProgressBar(state.phase === "downloading" ? (state.percent ?? 0) / 100 : -1);
    }
    if (state.phase !== phase) {
      phase = state.phase;
      rebuildMenu();
    }
  });
}
function updateMenuLabel(phase: DesktopUpdateState["phase"] | undefined) {
  if (phase === "checking") return t("Checking for Updates…");
  if (phase === "available" || phase === "downloading") return t("Downloading Update…");
  if (phase === "ready") return t("Restart to Update…");
  return t("Check for Updates…");
}
type MenuActions = {
  revokeLocalComputerAccess: ReturnType<typeof createLocalComputerChoice>["revoke"];
  updaterEnvironment: Parameters<typeof updaterSupport>[0];
};

/** The app menu's installer. It runs again whenever what the menu shows changes. */
export function applicationMenuInstaller({
  revokeLocalComputerAccess,
  updaterEnvironment,
}: MenuActions) {
  return function installApplicationMenu() {
    const computerAccess: Electron.MenuItemConstructorOptions = {
      label: t("Computer Access…"),
      visible: desktop.currentSetup?.mode === "new",
      click: () => desktop.mainWindow?.webContents.send("desktop.computer.configure"),
    };
    const revokeComputerAccess: Electron.MenuItemConstructorOptions = {
      label: t("Revoke Local Computer Access"),
      visible: remoteServerOrigin() === null && desktop.hostComputer?.isEnabled() === true,
      click: () => void revokeLocalComputerAccess().catch(() => undefined),
    };
    // Cmd+, is the macOS Settings chord, and no page keydown can see it: the OS takes
    // it first, so the menu item is the only place it can be registered.
    const openSettings: Electron.MenuItemConstructorOptions = {
      label: t("Settings…"),
      accelerator: "CmdOrCtrl+,",
      click: () => desktop.mainWindow?.webContents.send("desktop.settings.open"),
    };
    const updatePhase = desktop.desktopUpdater?.state().phase;
    const checkForUpdates: Electron.MenuItemConstructorOptions = {
      label: updateMenuLabel(updatePhase),
      enabled:
        updatePhase !== "checking" && updatePhase !== "available" && updatePhase !== "downloading",
      visible: updaterSupport(updaterEnvironment).supported,
      click: () => void checkForUpdatesFromMenu(),
    };
    const changeServer: Electron.MenuItemConstructorOptions = {
      id: "change-rakazo-server",
      label: t("Change Rakazo Server…"),
      accelerator: "CmdOrCtrl+Shift+K",
      click: () => showSetupWindow(),
    };
    const quitAndStopBots = quitAndStopBotsItem({
      mode: desktop.currentSetup?.mode,
      stackRunning: desktop.localStack.managedStackRunning(),
      stop: () => {
        desktop.hostComputer?.activate(false);
        return desktop.localStack.stop().then((state) => {
          if (state.phase === "failed") showSetupWindow(state.message);
          return state;
        });
      },
      quit: () => app.quit(),
      rebuildMenu: () => installApplicationMenu(),
    });
    const isMac = process.platform === "darwin";
    // The page handles these chords itself and stops them, so a key press runs them once; the menu
    // shows them and runs them on click. The page decides whether each one applies right now.
    const command = (
      label: string,
      accelerator: string,
      name: DesktopMenuCommand,
    ): Electron.MenuItemConstructorOptions => ({
      label,
      accelerator,
      click: (_item, window) => {
        if (window && window === desktop.mainWindow)
          desktop.mainWindow.webContents.send("desktop.menu.command", name);
      },
    });
    const newItem = command(t("New…"), "CmdOrCtrl+N", "new");
    const newGroupItem = command(t("New Group Chat"), "CmdOrCtrl+Shift+N", "new-group");
    const connectAppsItem = command(t("Connect Apps…"), "CmdOrCtrl+Shift+M", "integrations");
    const helpMenu: Electron.MenuItemConstructorOptions = {
      label: t("Help"),
      role: "help",
      submenu: [command(t("Keyboard Shortcuts"), "CmdOrCtrl+/", "shortcuts")],
    };
    // Electron's own Edit menu, plus Search. Electron names role items in English, so each one
    // gets its label to translate it.
    const macEdit: Electron.MenuItemConstructorOptions[] = [
      { type: "separator" },
      {
        label: t("Speech"),
        submenu: [
          { role: "startSpeaking", label: t("Start Speaking") },
          { role: "stopSpeaking", label: t("Stop Speaking") },
        ],
      },
    ];
    const editMenu: Electron.MenuItemConstructorOptions = {
      label: t("Edit"),
      submenu: [
        { role: "undo", label: t("Undo") },
        { role: "redo", label: t("Redo") },
        { type: "separator" },
        { role: "cut", label: t("Cut") },
        { role: "copy", label: t("Copy") },
        { role: "paste", label: t("Paste") },
        ...(isMac
          ? [{ role: "pasteAndMatchStyle", label: t("Paste and Match Style") } as const]
          : []),
        { role: "delete", label: t("Delete") },
        { role: "selectAll", label: t("Select All") },
        { type: "separator" },
        // A server page older than this menu handles Cmd/Ctrl+F itself (as bot search) but ignores
        // a click on this item, which it has no command for.
        command(t("Find…"), "CmdOrCtrl+F", "find"),
        command(t("Search Bots…"), "CmdOrCtrl+Shift+F", "search"),
        ...(isMac ? macEdit : []),
      ],
    };
    const goMenu: Electron.MenuItemConstructorOptions = {
      label: t("Go"),
      submenu: [
        command(t("Back"), isMac ? "Cmd+[" : "Alt+Left", "back"),
        command(t("Forward"), isMac ? "Cmd+]" : "Alt+Right", "forward"),
        { type: "separator" },
        command(t("Next Bot"), "Ctrl+Tab", "next-bot"),
        command(t("Previous Bot"), "Ctrl+Shift+Tab", "previous-bot"),
        { type: "separator" },
        command(t("Command Menu…"), "CmdOrCtrl+K", "command-menu"),
      ],
    };
    const viewMenu: Electron.MenuItemConstructorOptions = {
      label: t("View"),
      submenu: [
        command(t("Toggle Sidebar"), "CmdOrCtrl+B", "toggle-sidebar"),
        command(t("Chat Details"), "CmdOrCtrl+Shift+,", "chat-panel"),
        { type: "separator" },
        { role: "resetZoom", label: t("Actual Size") },
        { role: "zoomIn", label: t("Zoom In") },
        // zoomIn's default accelerator is Cmd/Ctrl+Plus, which needs Shift on US layouts.
        { role: "zoomIn", accelerator: "CommandOrControl+=", visible: false },
        { role: "zoomOut", label: t("Zoom Out") },
        // macOS adds its own Enter Full Screen item to a menu named "View"; a translated title
        // may not be recognized, so it gets the item explicitly.
        ...(process.platform === "darwin" && desktopLocale() === "en"
          ? []
          : ([
              { type: "separator" },
              { role: "togglefullscreen", label: t("Toggle Full Screen") },
            ] as const)),
      ],
    };
    const template: Electron.MenuItemConstructorOptions[] =
      process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about", label: t("About {name}", { name: app.name }) },
                openSettings,
                checkForUpdates,
                { type: "separator" },
                computerAccess,
                revokeComputerAccess,
                changeServer,
                { type: "separator" },
                { role: "hide", label: t("Hide {name}", { name: app.name }) },
                { role: "hideOthers", label: t("Hide Others") },
                { role: "unhide", label: t("Show All") },
                { type: "separator" },
                { role: "quit", label: t("Quit {name}", { name: app.name }) },
                quitAndStopBots,
              ],
            },
            {
              label: t("File"),
              submenu: [newItem, newGroupItem, { type: "separator" }, connectAppsItem],
            },
            editMenu,
            viewMenu,
            goMenu,
            {
              label: t("Window"),
              role: "window",
              submenu: [
                { role: "minimize", label: t("Minimize") },
                { role: "zoom", label: t("Zoom") },
                { role: "close", label: t("Close Window") },
                { type: "separator" },
                { role: "front", label: t("Bring All to Front") },
              ],
            },
            helpMenu,
          ]
        : [
            {
              label: t("File"),
              submenu: [
                newItem,
                newGroupItem,
                { type: "separator" },
                connectAppsItem,
                { type: "separator" },
                openSettings,
                computerAccess,
                revokeComputerAccess,
                changeServer,
                { type: "separator" },
                checkForUpdates,
                { type: "separator" },
                { role: "quit", label: process.platform === "win32" ? t("Exit") : t("Quit") },
                quitAndStopBots,
              ],
            },
            editMenu,
            viewMenu,
            goMenu,
            // The Window menu Electron builds for this role, with its items translated.
            {
              label: t("Window"),
              submenu: [
                { role: "minimize", label: t("Minimize") },
                { role: "zoom", label: t("Zoom") },
                { role: "close", label: t("Close") },
              ],
            },
            helpMenu,
          ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
}
