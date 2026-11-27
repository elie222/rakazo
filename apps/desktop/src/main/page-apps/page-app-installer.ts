import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { PAGE_APP_TOKEN } from "@rakazo/contracts";
import { pollUntil } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import {
  buildPageAppBundle,
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
import { createPageAppApi } from "./page-app-api.js";
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
    !Array.isArray(icon)
  )
    return null;
  if (!isPageAppIdentity(appId, pageId, title)) return null;
  const pngs = new Map<number, Buffer>();
  for (const entry of icon as unknown[]) {
    const { size, png } = (entry ?? {}) as { size?: unknown; png?: unknown };
    if (typeof size !== "number" || !ICNS_SIZES.includes(size)) continue;
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
  for (const pid of pids) process.kill(pid, "SIGTERM");
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
          const taken = await bundleNames(folder);
          if (previous) taken.delete(path.basename(previous.bundlePath));
          if (previous && existsSync(previous.bundlePath)) await remove(previous.bundlePath);
          const target = path.join(folder, uniqueBundleName(name, taken));
          await rename(built, target);
          return target;
        },
      );
      await registry.put({ ...config, bundlePath: placed });
      await bestEffort("register page app", registerWithLaunchServices(placed));
      await bestEffort("open page app", options.open(placed));
      return true;
    } catch (error) {
      if (placed !== null) await removeBundle(placed);
      if (!previous) await removePageAppData(request.appId, home);
      throw error;
    }
  }

  async function remove(bundle: string) {
    await stopApp(bundle);
    await bestEffort("unregister page app", unregisterFromLaunchServices(bundle));
    await options.trash(bundle);
  }

  async function uninstall(appId: string): Promise<boolean> {
    const app = (await registry.list()).find((entry) => entry.appId === appId);
    if (!app) return false;
    if (existsSync(app.bundlePath)) await remove(app.bundlePath);
    const token = await readPageAppToken(appId, home);
    if (token) await bestEffort("revoke page app", createPageAppApi(app.server, token).revoke());
    await removePageAppData(appId, home);
    await registry.remove(appId);
    return true;
  }

  /**
   * Makes each installed app again from this Rakazo when it was made from another version, so
   * apps get Rakazo's fixes. An app that is running is left for the next start.
   */
  async function refresh() {
    await removeBundle(path.join(pageAppsFolder(home), STAGING));
    for (const app of await registry.list()) {
      if (!existsSync(app.bundlePath)) continue;
      if ((await readBundleVersion(app.bundlePath)) === options.version) continue;
      if ((await runningAppPids(app.bundlePath)).length > 0) continue;
      const built = await readBuiltApp(app.bundlePath);
      const config = pageAppConfig(built.config);
      if (!config || config.appId !== app.appId) continue;
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
          await rename(next, app.bundlePath);
        },
      );
    }
  }

  return { install, uninstall, refresh };
}
