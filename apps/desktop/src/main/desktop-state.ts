import type { DesktopSetup } from "@rakazo/contracts";
import type { BrowserWindow } from "electron";
import type { UserDeviceAccess } from "./auth/user-device.js";
import type { prepareHostComputer } from "./this-computer/host-computer.js";
import type { StackController } from "./this-computer/local-stack.js";
import type { DesktopUpdateController } from "./updates/auto-update.js";
import type { AppTarget } from "./windows/app-frame.js";

/** Window, setup, and service state shared by the main process modules. */
export const desktop = {
  mainWindow: null,
  replacedAppWindow: null,
  setupWindow: null,
  currentSetup: null,
  currentTargetUrl: null,
  setupError: null,
  quitting: false,
  warmWindowTimer: undefined,
  // Number of short-lived hidden probe windows currently alive. On Windows/Linux,
  // destroying the last window fires "window-all-closed" -> app.quit(); a probe
  // that runs before the first real window exists must not count as "all closed".
  liveProbeWindows: 0,
  launchUpdateCheckScheduled: false,
  hostComputer: undefined,
  userDevices: undefined,
} as {
  mainWindow: BrowserWindow | null;
  /**
   * The app window a server switch is replacing, from the moment the next window takes its
   * place until the switch is committed (this window is destroyed) or abandoned (it is the
   * app window again).
   */
  replacedAppWindow: BrowserWindow | null;
  setupWindow: BrowserWindow | null;
  currentSetup: DesktopSetup | null;
  currentTargetUrl: string | null;
  setupError: string | null;
  quitting: boolean;
  warmWindowTimer: NodeJS.Timeout | undefined;
  liveProbeWindows: number;
  /** Created once the app's language is known, so its first message is in it. */
  desktopUpdater: DesktopUpdateController;
  launchUpdateCheckScheduled: boolean;
  localStack: StackController;
  hostComputer: Awaited<ReturnType<typeof prepareHostComputer>> | undefined;
  userDevices: UserDeviceAccess | undefined;
};

export const appWindowTargets = new WeakMap<BrowserWindow, string>();

function appTarget(win: BrowserWindow | null): AppTarget | null {
  if (win === null || win.isDestroyed()) return null;
  const url = appWindowTargets.get(win);
  return url === undefined ? null : { webContents: win.webContents, url };
}

/** The app window and the server it was opened for. */
export function permissionTarget(): AppTarget | null {
  return appTarget(desktop.mainWindow);
}

/** The window a server switch is replacing and the server it was opened for; null outside a switch. */
export function replacedAppTarget(): AppTarget | null {
  return appTarget(desktop.replacedAppWindow);
}
