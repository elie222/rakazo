import path from "node:path";
import type { ShortcutDetails } from "electron";
import { pageAppBundleId } from "./bundle-name.js";
import { pageAppArgument } from "./page-app-launch.js";

/** The Start Menu folder that holds every app's shortcut, inside Electron's `appData`. */
export function startMenuFolder(appData: string): string {
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Rakazo Apps");
}

/** Device names Windows reserves, alone or before any extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** An app name as a Windows file name, which also refuses these characters and trailing dots. */
export function windowsFileName(name: string): string {
  const safe = name.replace(/[<>"|?*]/g, "-").replace(/[.\s]+$/, "") || "Page";
  return RESERVED.test(safe) ? `${safe}_` : safe;
}

/** Starts Rakazo as the app, under the app's own taskbar identity and icon. */
export function pageAppShortcut(input: {
  executable: string;
  appId: string;
  icon: string;
  title: string;
}): ShortcutDetails {
  return {
    target: input.executable,
    args: pageAppArgument(input.appId),
    appUserModelId: pageAppBundleId(input.appId),
    icon: input.icon,
    iconIndex: 0,
    description: input.title,
  };
}
