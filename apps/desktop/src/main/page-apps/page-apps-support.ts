import { app } from "electron";

/** The preload offers `pageApps` only to app windows started with this argument. */
export const PAGE_APPS_ARGUMENT = "--rakazo-page-apps";

/** Installed page apps can be made only from a packaged Rakazo on macOS. */
export function pageAppsSupported() {
  return app.isPackaged && process.platform === "darwin";
}
