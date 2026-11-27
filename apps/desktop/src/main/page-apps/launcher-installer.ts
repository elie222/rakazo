import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bestEffort } from "@rakazo/logging";
import { PAGE_APP_ID } from "./bundle-name.js";
import { createPageAppApi, revokePageAppToken } from "./page-app-api.js";
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
      // Nothing will use the token now, so it ends here rather than waiting for the server.
      await bestEffort(
        "revoke an unfinished page app",
        createPageAppApi(server, request.token, options.fetch).revoke(),
      );
      throw error;
    }
    await bestEffort("open page app", options.open(request.appId));
    return true;
  }

  async function uninstall(appId: string): Promise<boolean> {
    const app = (await registry.list()).find((entry) => entry.appId === appId);
    if (!app) return false;
    await launcher.remove(app.bundlePath);
    await forget(app);
    return true;
  }

  /**
   * Revokes a removed app's token and clears what it left. A revoke that fails keeps the token
   * and the record, so `refresh` tries again on the next start.
   */
  async function forget(app: InstalledPageApp): Promise<boolean> {
    const token = await readPageAppToken(app.appId, appData);
    const api = token && createPageAppApi(app.server, token, options.fetch);
    if (api && !(await revokePageAppToken(api))) return false;
    // A running app holds files in its data folder on Windows. Without its token it is a
    // removed app's folder, which the app clears once it sees it was removed, or `refresh` does.
    await rm(pageAppTokenFile(app.appId, appData), { force: true });
    await bestEffort("remove page app data", removePageAppData(app.appId, appData));
    await registry.remove(app.appId);
    return true;
  }

  /**
   * Points launchers at Rakazo again if it moved, and clears what removed apps left behind,
   * including an app that uninstalled itself: its launcher and token are gone.
   */
  async function refresh() {
    const installed = new Set<string>();
    for (const app of await registry.list()) {
      if (existsSync(app.bundlePath)) {
        installed.add(app.appId);
        await bestEffort(
          "repoint page app",
          launcher.repoint(app, pageAppDataDir(app.appId, appData)),
        );
      } else if (!(await bestEffort("forget page app", forget(app)))) installed.add(app.appId);
    }
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
