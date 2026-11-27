import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "@rakazo/logging";
import { app, shell } from "electron";
import { pageAppBundleId, pageAppName, uniqueBundleName } from "./bundle-name.js";
import { applicationsDir, desktopEntry, desktopFileName } from "./desktop-entry.js";
import { writeIco } from "./ico.js";
import type { PageAppLauncher } from "./launcher-installer.js";
import { pageAppDataDir } from "./page-app-files.js";
import { launcherExecutable, pageAppArgument } from "./page-app-launch.js";
import { pageAppShortcut, startMenuFolder, windowsFileName } from "./windows-shortcut.js";

const WINDOWS_ICON = "icon.ico";
const LINUX_ICON = "icon.png";
const LINUX_ICON_SIZE = 512;

const executable = () => launcherExecutable(process.env, process.execPath);

function windowsLauncher(appData: string): PageAppLauncher {
  const folder = startMenuFolder(appData);
  const details = (app: { appId: string; title: string }, dataDir: string) =>
    pageAppShortcut({
      executable: executable(),
      appId: app.appId,
      icon: path.join(dataDir, WINDOWS_ICON),
      title: app.title,
    });
  return {
    write: async ({ config, icon, dataDir }) => {
      await writeFile(path.join(dataDir, WINDOWS_ICON), writeIco(icon));
      await mkdir(folder, { recursive: true });
      const taken = new Set(await readdir(folder));
      const name = uniqueBundleName(windowsFileName(pageAppName(config.title)), taken, ".lnk");
      const shortcut = path.join(folder, name);
      if (!shell.writeShortcutLink(shortcut, details(config, dataDir)))
        throw new Error("The shortcut could not be written.");
      return shortcut;
    },
    repoint: async (installed, dataDir) => {
      if (shell.readShortcutLink(installed.bundlePath).target === executable()) return;
      if (!shell.writeShortcutLink(installed.bundlePath, "replace", details(installed, dataDir)))
        throw new Error("The shortcut could not be written.");
    },
    remove: (shortcut) => rm(shortcut, { force: true }),
    find: async (appId) => (await ownShortcuts(folder, appId))[0] ?? null,
  };
}

function linuxLauncher(): PageAppLauncher {
  const entryText = (app: { appId: string; title: string }, dataDir: string) =>
    desktopEntry({
      appId: app.appId,
      name: pageAppName(app.title),
      executable: executable(),
      icon: path.join(dataDir, LINUX_ICON),
    });
  return {
    write: async ({ config, icon, dataDir }) => {
      const largest = Math.max(...[...icon.keys()].filter((size) => size <= LINUX_ICON_SIZE));
      const png = icon.get(LINUX_ICON_SIZE) ?? icon.get(largest);
      if (!png) throw new Error("No icon image is small enough for a desktop entry.");
      await writeFile(path.join(dataDir, LINUX_ICON), png);
      const folder = applicationsDir(process.env);
      await mkdir(folder, { recursive: true });
      const entry = path.join(folder, desktopFileName(config.appId));
      // Written beside it and moved into place, so a failed write leaves no broken entry.
      const next = `${entry}.${process.pid}.tmp`;
      try {
        await writeFile(next, entryText(config, dataDir));
        await rename(next, entry);
      } finally {
        await rm(next, { force: true });
      }
      return entry;
    },
    repoint: async (installed, dataDir) => {
      const text = entryText(installed, dataDir);
      if ((await readFile(installed.bundlePath, "utf8")) !== text)
        await writeFile(installed.bundlePath, text);
    },
    remove: (entry) => rm(entry, { force: true }),
    find: async (appId) => {
      const entry = path.join(applicationsDir(process.env), desktopFileName(appId));
      return existsSync(entry) ? entry : null;
    },
  };
}

/** The shortcuts in Rakazo's Start Menu folder that start this app. */
async function ownShortcuts(folder: string, appId: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const argument = pageAppArgument(appId);
  return (await readdir(folder))
    .filter((name) => name.toLowerCase().endsWith(".lnk"))
    .map((name) => path.join(folder, name))
    .filter((shortcut) => ownShortcut(shortcut, argument));
}

/** The launcher kind of the running platform; macOS apps are bundles instead. */
export function platformLauncher(appData: string): PageAppLauncher {
  return process.platform === "win32" ? windowsLauncher(appData) : linuxLauncher();
}

/** Starts an installed app the way its launcher does. */
export async function startPageApp(appId: string) {
  const child = spawn(executable(), [pageAppArgument(appId)], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

/** Run by an app its launcher started, before any window: it takes its launcher's identity. */
export function adoptLauncherIdentity(appId: string) {
  if (process.platform === "win32") app.setAppUserModelId(pageAppBundleId(appId));
  // Electron names the windows' WM_CLASS and Wayland app id after the desktop name.
  else app.setDesktopName(desktopFileName(appId));
}

export function launcherIcon(appId: string, appData: string): string {
  return path.join(
    pageAppDataDir(appId, appData),
    process.platform === "win32" ? WINDOWS_ICON : LINUX_ICON,
  );
}

/** Whether a shortcut starts this app; one that cannot be read is someone else's. */
function ownShortcut(shortcut: string, argument: string): boolean {
  try {
    return shell.readShortcutLink(shortcut).args === argument;
  } catch (error) {
    getLogger().warn("page app skipped a shortcut it could not read", { error });
    return false;
  }
}

/** Removes the launcher of an app that uninstalls itself, wherever Rakazo put it. */
export async function removeOwnLauncher(appId: string, appData: string) {
  if (process.platform !== "win32") {
    await rm(path.join(applicationsDir(process.env), desktopFileName(appId)), { force: true });
    return;
  }
  for (const shortcut of await ownShortcuts(startMenuFolder(appData), appId))
    await rm(shortcut, { force: true });
}
