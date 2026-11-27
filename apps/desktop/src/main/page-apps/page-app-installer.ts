import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PAGE_APP_TOKEN } from "@rakazo/contracts";
import { deadlineSignal, pollUntil } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import {
  buildPageAppBundle,
  findBundle,
  readBuiltApp,
  readBundleVersion,
  registerWithLaunchServices,
  removeBundle,
  runningAppPids,
  runningBundle,
  unregisterFromLaunchServices,
} from "./bundle-builder.js";
import { pageAppBundleId, pageAppName, uniqueBundleName } from "./bundle-name.js";
import { ICNS_SIZES, isSquarePng, writeIcns } from "./icns.js";
import { createOneAtATime } from "./one-at-a-time.js";
import { createPageAppApi, revokePageAppToken } from "./page-app-api.js";
import type { PageAppConfig } from "./page-app-files.js";
import {
  isPageAppIdentity,
  pageAppConfig,
  pageAppsFolder,
  readPageAppToken,
  readServerOverride,
  removePageAppData,
  writePageAppToken,
} from "./page-app-files.js";
import type { InstalledPageApp } from "./registry.js";

const MAX_ICON_BASE64 = 4 * 1024 * 1024;
/** One drawing per size the web app renders, with room to spare; a longer list is refused unread. */
const MAX_ICON_ENTRIES = 12;
/** Where bundles are made before they appear in the apps folder, on the same volume. */
const STAGING = ".staging";
const SET_ASIDE = ".previous.app";
const MARK_USED_DEADLINE_MS = 15_000;
const RETIRED = ".retired.app";

export type PageAppInstallRequest = {
  appId: string;
  pageId: string;
  title: string;
  token: string;
  icon: Map<number, Buffer>;
};

/** The bridge's install input when every part is usable; null otherwise. */
export function pageAppInstallRequest(value: unknown): PageAppInstallRequest | null {
  if (!value || typeof value !== "object") return null;
  const { appId, pageId, title, token, icon } = value as Record<string, unknown>;
  if (
    typeof appId !== "string" ||
    typeof token !== "string" ||
    !PAGE_APP_TOKEN.test(token) ||
    !Array.isArray(icon) ||
    icon.length > MAX_ICON_ENTRIES
  )
    return null;
  if (!isPageAppIdentity(appId, pageId, title)) return null;
  const pngs = new Map<number, Buffer>();
  for (const entry of icon as unknown[]) {
    const { size, png } = (entry ?? {}) as { size?: unknown; png?: unknown };
    if (typeof size !== "number" || pngs.has(size)) return null;
    if (!ICNS_SIZES.includes(size)) continue;
    if (typeof png !== "string" || png.length > MAX_ICON_BASE64) return null;
    const bytes = Buffer.from(png, "base64");
    if (!isSquarePng(bytes, size)) return null;
    pngs.set(size, bytes);
  }
  if (pngs.size === 0) return null;
  return {
    appId: appId as string,
    pageId: pageId as string,
    title: title as string,
    token,
    icon: pngs,
  };
}

type Registry = {
  list: () => Promise<InstalledPageApp[]>;
  put: (app: InstalledPageApp) => Promise<void>;
  remove: (appId: string) => Promise<void>;
};

async function bundleNames(folder: string) {
  try {
    return new Set(await readdir(folder));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw error;
  }
}

/** Builds in the staging folder, then calls `place` with the finished bundle; leaves nothing on failure. */
async function staged<T>(
  home: string | undefined,
  build: (target: string) => Promise<void>,
  place: (built: string) => Promise<T>,
): Promise<T> {
  const staging = path.join(pageAppsFolder(home), STAGING, randomUUID());
  await mkdir(staging, { recursive: true });
  try {
    const built = path.join(staging, "app.app");
    await build(built);
    return await place(built);
  } finally {
    await removeBundle(staging);
    // Another install may still be staging there.
    await rmdir(path.dirname(staging)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY") throw error;
    });
  }
}

async function stopApp(bundle: string) {
  const pids = await runningAppPids(bundle);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      // It quit between the lookup and the signal.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (pids.length === 0) return;
  await pollUntil(async () => (await runningAppPids(bundle)).length === 0, {
    intervalMs: 200,
    timeoutMs: 10_000,
    waitingFor: "the page app to quit",
  });
}

/** The apps found in the apps folder by their own config, for a registry that has to be rebuilt. */
export async function installedBundles(home?: string): Promise<InstalledPageApp[]> {
  const folder = pageAppsFolder(home);
  const found = await Promise.all(
    [...(await bundleNames(folder))]
      .filter((name) => name.endsWith(".app"))
      .map(async (name) => {
        const bundlePath = path.join(folder, name);
        const built = await bestEffort("read a page app bundle", readBuiltApp(bundlePath));
        const config = built ? pageAppConfig(built.config) : null;
        // The server an app was moved to wins over the one in its bundle.
        const server = config ? (readServerOverride(config.appId, home) ?? config.server) : null;
        return config && server ? [{ ...config, server, bundlePath }] : [];
      }),
  );
  return found.flat();
}

export function createPageAppInstaller(options: {
  registry: Registry;
  /** Moves a bundle to the Trash. */
  trash: (bundle: string) => Promise<void>;
  /** Opens a bundle as an app. */
  open: (bundle: string) => Promise<void>;
  version: string;
  home?: string;
  source?: string;
}) {
  const { registry, home } = options;
  const source = options.source ?? runningBundle();
  const exclusive = createOneAtATime();

  async function install(request: PageAppInstallRequest, server: string): Promise<boolean> {
    const config: PageAppConfig = {
      appId: request.appId,
      pageId: request.pageId,
      title: request.title,
      server,
    };
    const name = pageAppName(request.title);
    const folder = pageAppsFolder(home);
    // Every install has a new app id, so there is never an earlier bundle to replace.
    if ((await registry.list()).some((app) => app.appId === request.appId)) return false;
    let placed: string | null = null;
    try {
      placed = await staged(
        home,
        (target) =>
          buildPageAppBundle({
            source,
            target,
            name,
            bundleId: pageAppBundleId(request.appId),
            icon: writeIcns(request.icon),
            config,
          }),
        async (built) => {
          await writePageAppToken(request.appId, request.token, home);
          const target = path.join(folder, uniqueBundleName(name, await bundleNames(folder)));
          await rename(built, target);
          return target;
        },
      );
      await registry.put({ ...config, bundlePath: placed });
      // One read marks the token used, so the server's cleanup of never-used apps leaves this one
      // even if its first launch does not get through.
      await bestEffort(
        "mark a page app installed",
        createPageAppApi(server, request.token).view(deadlineSignal(MARK_USED_DEADLINE_MS)),
      );
      await bestEffort("register page app", registerWithLaunchServices(placed));
      await bestEffort("open page app", options.open(placed));
      return true;
    } catch (error) {
      // Nothing will use the token now, so it ends first, before any cleanup that could fail.
      await revokePageAppToken(createPageAppApi(server, request.token));
      if (placed !== null) await bestEffort("remove an unfinished page app", removeBundle(placed));
      await bestEffort(
        "remove an unfinished page app's data",
        removePageAppData(request.appId, home),
      );
      throw error;
    }
  }

  async function remove(bundle: string) {
    await stopApp(bundle);
    await bestEffort("unregister page app", unregisterFromLaunchServices(bundle));
    await options.trash(bundle);
  }

  /** Drops an app whose bundle is gone; until its token is revoked, the next start tries again. */
  async function forget(app: InstalledPageApp) {
    const token = await readPageAppToken(app.appId, home);
    if (token && !(await revokePageAppToken(createPageAppApi(app.server, token)))) return;
    await removePageAppData(app.appId, home);
    await registry.remove(app.appId);
  }

  async function uninstall(appId: string): Promise<boolean> {
    const app = (await registry.list()).find((entry) => entry.appId === appId);
    if (!app) return false;
    if (existsSync(app.bundlePath)) await remove(app.bundlePath);
    await forget(app);
    return true;
  }

  async function refreshApp(app: InstalledPageApp) {
    // An app moved to the Trash from Finder ends with its token, as an uninstall does.
    if (!existsSync(app.bundlePath)) {
      // Renamed in its folder, it is found there; moved anywhere else, Spotlight may know.
      const moved =
        (await installedBundles(home)).find((found) => found.appId === app.appId)?.bundlePath ??
        (await findBundle(pageAppBundleId(app.appId), home ?? os.homedir()));
      if (moved) await registry.put({ ...app, bundlePath: moved });
      else await forget(app);
      return;
    }
    if ((await readBundleVersion(app.bundlePath)) === options.version) return;
    if ((await runningAppPids(app.bundlePath)).length > 0) return;
    const built = await readBuiltApp(app.bundlePath);
    const old = setAside(app.appId);
    const config = pageAppConfig(built.config);
    if (!config || config.appId !== app.appId) return;
    await staged(
      home,
      (target) =>
        buildPageAppBundle({
          source,
          target,
          name: pageAppName(config.title),
          bundleId: pageAppBundleId(app.appId),
          icon: built.icon,
          config,
        }),
      async (next) => {
        // Building takes a while; an app opened meanwhile is left for the next start, and so is
        // one whose earlier bundle still runs from where it was set aside.
        if ((await runningAppPids(app.bundlePath)).length > 0) return;
        if ((await runningAppPids(old)).length > 0) return;
        if ((await runningAppPids(retired(app.appId))).length > 0) return;
        await removeBundle(old);
        await removeBundle(retired(app.appId));
        await rename(app.bundlePath, old);
        try {
          await rename(next, app.bundlePath);
        } catch (error) {
          await rename(old, app.bundlePath);
          throw error;
        }
        // The swap is done: the old bundle is no longer one to put back, only one to remove.
        await rename(old, retired(app.appId));
      },
    );
  }

  /** Where an app's bundle waits while an update swaps in its replacement. */
  const setAside = (appId: string) =>
    path.join(pageAppsFolder(home), STAGING, `${appId}${SET_ASIDE}`);
  /** Where it waits once the swap is done, until nothing runs from it. */
  const retired = (appId: string) => path.join(pageAppsFolder(home), STAGING, `${appId}${RETIRED}`);

  /**
   * Clears what earlier runs left in the staging folder: an unfinished build goes, and a bundle
   * set aside by an update goes back if the update never placed its replacement, or is removed
   * once nothing runs from it.
   */
  async function settleStaging() {
    const staging = path.join(pageAppsFolder(home), STAGING);
    const apps = await registry.list();
    for (const name of await bundleNames(staging)) {
      const entry = path.join(staging, name);
      const app = apps.find(
        (each) => setAside(each.appId) === entry || retired(each.appId) === entry,
      );
      // Only a swap cut off before its replacement arrived puts the old bundle back; a retired one
      // never returns, even when the app has since been removed.
      if (app && entry === setAside(app.appId) && !existsSync(app.bundlePath)) {
        await rename(entry, app.bundlePath);
        continue;
      }
      // A process keeps the path it started from, so one running from a set-aside bundle
      // still shows the app's own path.
      const running = [entry, ...(app ? [app.bundlePath] : [])];
      if ((await Promise.all(running.map(runningAppPids))).every((pids) => pids.length === 0))
        await removeBundle(entry);
    }
  }

  /** Records an app whose install placed its bundle but ended before writing the registry. */
  async function adoptUntracked() {
    const known = new Set((await registry.list()).map((app) => app.appId));
    for (const found of await installedBundles(home))
      if (!known.has(found.appId)) await registry.put(found);
  }

  /**
   * Makes each installed app again from this Rakazo when it was made from another version, so
   * apps get Rakazo's fixes. An app that is running is left for the next start.
   */
  async function refresh() {
    await exclusive(async () => {
      await settleStaging();
      await adoptUntracked();
    });
    // One app at a time, so an open or install waits for one rebuild, not all of them.
    for (const app of await registry.list()) {
      // One app that cannot be rebuilt or forgotten leaves the others to go ahead.
      await exclusive(() => bestEffort(`refresh page app ${app.appId}`, refreshApp(app)));
    }
  }

  return {
    install: (request: PageAppInstallRequest, server: string) =>
      exclusive(() => install(request, server)),
    uninstall: (appId: string) => exclusive(() => uninstall(appId)),
    refresh,
    /** Settles once no install, removal or update is moving a bundle. */
    idle: () => exclusive(async () => undefined),
  };
}
