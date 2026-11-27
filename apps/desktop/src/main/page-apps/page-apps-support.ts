import { app } from "electron";

/** The preload offers `pageApps` only to app windows started with this argument. */
export const PAGE_APPS_ARGUMENT = "--rakazo-page-apps";

/** Installed page apps start from Rakazo's own installed files, so only a packaged Rakazo makes them. */
export function pageAppsSupported() {
  return app.isPackaged;
}
