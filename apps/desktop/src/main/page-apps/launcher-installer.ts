import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deadlineSignal } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { PAGE_APP_ID } from "./bundle-name.js";
import { createOneAtATime } from "./one-at-a-time.js";
import { createPageAppApi, revokePageAppToken } from "./page-app-api.js";
import type { PageAppConfig } from "./page-app-files.js";
import {
  PAGE_APP_CONFIG_FILE,
  pageAppConfig,
  pageAppDataDir,
  pageAppsDataDir,
  pageAppTokenFile,
  readPageAppHeaders,
  readPageAppToken,
  readServerOverride,
  removePageAppData,
  writePageAppHeaders,
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
  }) => Promise<string>;
  /** Writes the launcher again when it no longer starts the running Rakazo, which moved. */
  repoint: (app: InstalledPageApp, dataDir: string) => Promise<void>;
  remove: (launcher: string) => Promise<void>;
  /** The launcher that starts this app, wherever it is, for an app missing from the registry. */
  find: (appId: string) => Promise<string | null>;
};

/** More copies than anyone makes by hand; the cap keeps a launcher that cannot be removed from looping. */
const MAX_COPIES = 20;
const MARK_USED_DEADLINE_MS = 15_000;

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The config an app keeps in its data folder, when it is there and names that app. */
async function readLauncherConfig(appId: string, appData: string): Promise<PageAppConfig | null> {
  const text = await bestEffort(
    "read a page app's config",
    readFile(path.join(pageAppDataDir(appId, appData), PAGE_APP_CONFIG_FILE), "utf8"),
  );
  const config = text ? pageAppConfig(parsedJson(text)) : null;
  if (config?.appId !== appId) return null;
  return { ...config, server: readServerOverride(appId, appData) ?? config.server };
}

/**
 * The apps found by their data folders: each one holding a token and a config, with the launcher
 * that starts it. A registry that was lost or broken is rebuilt from these.
 */
export async function launcherApps(
  appData: string,
  launcher: Pick<PageAppLauncher, "find">,
): Promise<InstalledPageApp[]> {
  let folders: string[];
  try {
    folders = await readdir(pageAppsDataDir(appData));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: InstalledPageApp[] = [];
  for (const appId of folders) {
    if (!PAGE_APP_ID.test(appId) || !existsSync(pageAppTokenFile(appId, appData))) continue;
    const config = await readLauncherConfig(appId, appData);
    const bundlePath = config ? await launcher.find(appId) : null;
    if (config && bundlePath) found.push({ ...config, bundlePath });
  }
  return found;
}

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

  async function install(
    request: PageAppInstallRequest,
    server: string,
    serverHeaders: Record<string, string> = {},
  ): Promise<boolean> {
    const api = createPageAppApi(server, request.token, options.fetch, serverHeaders);
    const config: PageAppConfig = {
      appId: request.appId,
      pageId: request.pageId,
      title: request.title,
      server,
    };
    const dataDir = pageAppDataDir(request.appId, appData);
    // Every install has a new app id, so one already recorded is never replaced.
    if ((await registry.list()).some((app) => app.appId === request.appId)) return false;
    let written: string | null = null;
    try {
      await writePageAppToken(request.appId, request.token, appData);
      await writePageAppHeaders(request.appId, serverHeaders, appData);
      await writeConfig(config);
      written = await launcher.write({
        config,
        icon: request.icon,
        dataDir,
      });
      await registry.put({ ...config, bundlePath: written });
      // One read marks the token used, so the server's cleanup of never-used apps leaves this one
      // even if its first launch does not get through.
      await bestEffort(
        "mark a page app installed",
        api.view(deadlineSignal(MARK_USED_DEADLINE_MS)),
      );
    } catch (error) {
      // Nothing will use the token now, so it ends first, before any cleanup that could fail.
      await revokePageAppToken(api);
      if (written !== null)
        await bestEffort("remove an unfinished launcher", launcher.remove(written));
      await bestEffort(
        "remove an unfinished page app's data",
        removePageAppData(request.appId, appData),
      );
      throw error;
    }
    await bestEffort("open page app", options.open(request.appId));
    return true;
  }

  async function uninstall(appId: string): Promise<boolean> {
    const app = (await registry.list()).find((entry) => entry.appId === appId);
    if (!app) return false;
    // Only launchers that start this app go: the recorded one, found again in case it was
    // renamed (and its name since reused by another app), and any copy the person made.
    for (
      let copies = 0, found = await launcher.find(appId);
      found && copies < MAX_COPIES;
      copies++
    ) {
      await launcher.remove(found);
      found = await launcher.find(appId);
    }
    await forget(app);
    return true;
  }

  /**
   * Revokes a removed app's token and clears what it left. A revoke that fails keeps the token
   * and the record, so `refresh` tries again on the next start.
   */
  async function forget(app: InstalledPageApp): Promise<boolean> {
    const token = await readPageAppToken(app.appId, appData);
    const headers = await readPageAppHeaders(app.appId, appData);
    const api = token && createPageAppApi(app.server, token, options.fetch, headers);
    if (api && !(await revokePageAppToken(api))) return false;
    // A running app holds files in its data folder on Windows. Without its token it is a
    // removed app's folder, which the app clears once it sees it was removed, or `refresh` does.
    await rm(pageAppTokenFile(app.appId, appData), { force: true });
    await bestEffort("remove page app data", removePageAppData(app.appId, appData));
    await registry.remove(app.appId);
    return true;
  }

  async function writeConfig(app: PageAppConfig) {
    const { appId, pageId, title, server } = app;
    await writeFile(
      path.join(pageAppDataDir(appId, appData), PAGE_APP_CONFIG_FILE),
      `${JSON.stringify({ appId, pageId, title, server })}\n`,
    );
  }

  /**
   * Points launchers at Rakazo again if it moved, and clears what removed apps left behind,
   * including an app that uninstalled itself: its launcher and token are gone.
   */
  async function refresh() {
    // An app whose install was never recorded, or whose record was lost, is taken back.
    const known = new Set((await registry.list()).map((app) => app.appId));
    for (const found of await launcherApps(appData, launcher))
      if (!known.has(found.appId)) await registry.put(found);
    const installed = new Set<string>();
    for (const listed of await registry.list()) {
      // A launcher the person renamed or moved is followed, not taken for a removed app.
      const moved = existsSync(listed.bundlePath) ? null : await launcher.find(listed.appId);
      const app = moved ? { ...listed, bundlePath: moved } : listed;
      if (moved) await registry.put(app);
      // A launcher whose app has no usable token can never open its page: the app removed
      // itself (even if a rewrite raced the launcher back) or its token was damaged. It goes,
      // with the app's data and record.
      const hasToken = (await readPageAppToken(app.appId, appData)) !== null;
      const config = await readLauncherConfig(app.appId, appData);
      if (existsSync(app.bundlePath) && !hasToken) {
        // The record stays until the launcher is gone, so a later start can try again.
        const removed = await bestEffort(
          "remove a removed app's launcher",
          launcher.remove(app.bundlePath).then(() => true),
        );
        if (removed) {
          await bestEffort("remove page app data", removePageAppData(app.appId, appData));
          await registry.remove(app.appId);
        }
        continue;
      }
      // An app whose token is still there but whose config was lost gets it back from its record.
      if (hasToken && !config) await bestEffort("restore a page app's config", writeConfig(app));
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
      // A folder no record or launcher claims is left by an install cut off midway: a token in
      // it is revoked through its config's server, and one without a config is unusable anyway.
      const config = await readLauncherConfig(appId, appData);
      if (config && existsSync(pageAppTokenFile(appId, appData))) {
        await bestEffort("forget an unfinished page app", forget({ ...config, bundlePath: "" }));
        continue;
      }
      await bestEffort("remove page app data", removePageAppData(appId, appData));
    }
  }

  // An install writes its token and config before its launcher and record, so a refresh, or
  // another install choosing a shortcut name, never runs in between.
  const exclusive = createOneAtATime();
  return {
    install: (
      request: PageAppInstallRequest,
      server: string,
      serverHeaders?: Record<string, string>,
    ) => exclusive(() => install(request, server, serverHeaders)),
    uninstall: (appId: string) => exclusive(() => uninstall(appId)),
    refresh: () => exclusive(refresh),
    /** A launcher never moves while its app could open, so there is nothing to wait for. */
    idle: async () => undefined,
  };
}
