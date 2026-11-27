import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bestEffort } from "@rakazo/logging";
import { PAGE_APP_ID } from "./bundle-name.js";
import { createPageAppApi } from "./page-app-api.js";
import type { PageAppConfig } from "./page-app-files.js";
import {
  PAGE_APP_CONFIG_FILE,
  pageAppDataDir,
  pageAppsDataDir,
  pageAppTokenFile,
  readPageAppToken,
  removePageAppData,
  writePageAppToken,
} from "./page-app-files.js";
import type { PageAppInstallRequest } from "./page-app-installer.js";
import type { InstalledPageApp } from "./registry.js";

/** What starts an app on Windows (a Start Menu shortcut) or Linux (a desktop entry). */
export type PageAppLauncher = {
  /** Writes the app's icon into its data folder and its launcher; returns the launcher's path. */
  write: (input: {
    config: PageAppConfig;
    icon: ReadonlyMap<number, Buffer>;
    dataDir: string;
    previous: string | null;
  }) => Promise<string>;
  /** Writes the launcher again when it no longer starts the running Rakazo, which moved. */
  repoint: (app: InstalledPageApp, dataDir: string) => Promise<void>;
  remove: (launcher: string) => Promise<void>;
};

type Registry = {
  list: () => Promise<InstalledPageApp[]>;
  put: (app: InstalledPageApp) => Promise<void>;
  remove: (appId: string) => Promise<void>;
};

/**
 * Installs apps that are Rakazo itself started with the app's id: its config, token and icon
 * live in its data folder, and only a launcher is added for the system.
 */
export function createLauncherInstaller(options: {
  registry: Registry;
  launcher: PageAppLauncher;
  /** Starts an installed app. */
  open: (appId: string) => Promise<void>;
  appData: string;
  fetch?: typeof fetch;
}) {
  const { registry, launcher, appData } = options;

  async function install(request: PageAppInstallRequest, server: string): Promise<boolean> {
    const config: PageAppConfig = {
      appId: request.appId,
      pageId: request.pageId,
      title: request.title,
      server,
    };
    const dataDir = pageAppDataDir(request.appId, appData);
    const previous = (await registry.list()).find((app) => app.appId === request.appId);
    let written: string | null = null;
    try {
      await writePageAppToken(request.appId, request.token, appData);
      await writeFile(path.join(dataDir, PAGE_APP_CONFIG_FILE), `${JSON.stringify(config)}\n`);
      written = await launcher.write({
        config,
        icon: request.icon,
        dataDir,
        previous: previous?.bundlePath ?? null,
      });
      await registry.put({ ...config, bundlePath: written });
    } catch (error) {
      if (!previous) {
        if (written !== null) await launcher.remove(written);
        await removePageAppData(request.appId, appData);
      }
      throw error;
    }
    await bestEffort("open page app", options.open(request.appId));
    return true;
  }

  async function uninstall(appId: string): Promise<boolean> {
    const app = (await registry.list()).find((entry) => entry.appId === appId);
    if (!app) return false;
    await launcher.remove(app.bundlePath);
    const token = await readPageAppToken(appId, appData);
    if (token)
      await bestEffort(
        "revoke page app",
        createPageAppApi(app.server, token, options.fetch).revoke(),
      );
    // A running app holds files in its data folder on Windows. Once it sees it was removed it
    // removes what it can, and `refresh` clears the rest.
    await bestEffort("remove page app data", removePageAppData(appId, appData));
    await registry.remove(appId);
    return true;
  }

  /** Points launchers at Rakazo again if it moved, and clears data left by removed apps. */
  async function refresh() {
    const apps = await registry.list();
    for (const app of apps) {
      if (!existsSync(app.bundlePath)) continue;
      await bestEffort(
        "repoint page app",
        launcher.repoint(app, pageAppDataDir(app.appId, appData)),
      );
    }
    const installed = new Set(apps.map((app) => app.appId));
    let folders: string[];
    try {
      folders = await readdir(pageAppsDataDir(appData));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const appId of folders) {
      if (!PAGE_APP_ID.test(appId) || installed.has(appId)) continue;
      if (existsSync(pageAppTokenFile(appId, appData))) continue;
      await bestEffort("remove page app data", removePageAppData(appId, appData));
    }
  }

  return { install, uninstall, refresh };
}
