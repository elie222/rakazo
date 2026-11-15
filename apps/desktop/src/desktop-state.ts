import type { DesktopSetup } from "@rakazo/contracts";
import type { BrowserWindow } from "electron";
import type { DesktopUpdateController } from "./auto-update.js";
import type { prepareHostComputer } from "./host-computer.js";
import type { StackController } from "./local-stack.js";
import type { UserDeviceAccess } from "./user-device.js";

/** Window, setup, and service state shared by the main process modules. */
export const desktop = {
  mainWindow: null,
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
