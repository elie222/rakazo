import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PAGE_APP_TOKEN } from "@rakazo/contracts";
import { pollUntil } from "@rakazo/core";
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
import { createPageAppApi, revokePageAppToken } from "./page-app-api.js";
import type { PageAppConfig } from "./page-app-files.js";
import {
  isPageAppIdentity,
  pageAppConfig,
  pageAppsFolder,
  readPageAppToken,
  removePageAppData,
  writePageAppToken,
} from "./page-app-files.js";
import type { InstalledPageApp } from "./registry.js";

const MAX_ICON_BASE64 = 4 * 1024 * 1024;
/** One drawing per size the web app renders, with room to spare; a longer list is refused unread. */
const MAX_ICON_ENTRIES = 12;
/** Where bundles are made before they appear in the apps folder, on the same volume. */
const STAGING = ".staging";

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
  // Installs, removals and refreshes share the registry, token files and staging folder.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    // The caller gets the failure; the next one waits only for this one to settle.
    queue = Promise.allSettled([next]);
    return next;
  };

  async function install(request: PageAppInstallRequest, server: string): Promise<boolean> {
    const config: PageAppConfig = {
      appId: request.appId,
      pageId: request.pageId,
      title: request.title,
      server,
    };
    const name = pageAppName(request.title);
    const folder = pageAppsFolder(home);
    const previous = (await registry.list()).find((app) => app.appId === request.appId);
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
      // The old bundle goes only once its replacement is in place and recorded.
      if (previous && previous.bundlePath !== placed && existsSync(previous.bundlePath))
        await bestEffort("remove replaced page app", remove(previous.bundlePath));
      await bestEffort("register page app", registerWithLaunchServices(placed));
      await bestEffort("open page app", options.open(placed));
      return true;
    } catch (error) {
      if (placed !== null) await removeBundle(placed);
      if (!previous) await removePageAppData(request.appId, home);
      // Nothing will use the token now, so it ends here rather than waiting for the server.
      await bestEffort(
        "revoke an unfinished page app",
        createPageAppApi(server, request.token).revoke(),
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
      const moved = await findBundle(pageAppBundleId(app.appId), home ?? os.homedir());
      if (moved) await registry.put({ ...app, bundlePath: moved });
      else await forget(app);
      return;
    }
    if ((await readBundleVersion(app.bundlePath)) === options.version) return;
    if ((await runningAppPids(app.bundlePath)).length > 0) return;
    const built = await readBuiltApp(app.bundlePath);
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
        const old = `${next}.old`;
        await rename(app.bundlePath, old);
        try {
          await rename(next, app.bundlePath);
        } catch (error) {
          await rename(old, app.bundlePath);
          throw error;
        }
      },
    );
  }

  /**
   * Makes each installed app again from this Rakazo when it was made from another version, so
   * apps get Rakazo's fixes. An app that is running is left for the next start.
   */
  async function refresh() {
    await removeBundle(path.join(pageAppsFolder(home), STAGING));
    for (const app of await registry.list()) {
      // One app that cannot be rebuilt or forgotten leaves the others to go ahead.
      await bestEffort(`refresh page app ${app.appId}`, refreshApp(app));
    }
  }

  return {
    install: (request: PageAppInstallRequest, server: string) =>
      exclusive(() => install(request, server)),
    uninstall: (appId: string) => exclusive(() => uninstall(appId)),
    refresh: () => exclusive(refresh),
  };
}
