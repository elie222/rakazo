import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PageAppConfig } from "./page-app-files.js";
import { PAGE_APP_CONFIG_FILE } from "./page-app-files.js";

const run = promisify(execFile);

const PLUTIL = "/usr/bin/plutil";
const CODESIGN = "/usr/bin/codesign";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Electron finds each helper as `<app name> Helper<suffix>.app`. */
const HELPER_SUFFIXES = ["", " (GPU)", " (Plugin)", " (Renderer)"];

/** What only Rakazo itself runs: its web app, local stack, speech helper, updater and icon. */
const UNUSED = [
  "Resources/web",
  "Resources/stack",
  "Resources/server-bundle.json",
  "Resources/speech",
  "Resources/app-update.yml",
  "Resources/Assets.car",
  "embedded.provisionprofile",
];

export const ICON_FILE = "icon.icns";

type Plist = Record<string, unknown>;

/** The running Rakazo's own bundle, the one every page app is cloned from. */
export function runningBundle(execPath = process.execPath): string {
  return path.resolve(execPath, "../../..");
}

/** The app's Info.plist: its own name, identity and icon, and none of Rakazo's link handling. */
export function pageAppInfo(info: Plist, name: string, bundleId: string): Plist {
  const {
    CFBundleIconName: _icon,
    CFBundleURLTypes: _links,
    ElectronTeamID: _team,
    ...kept
  } = info;
  return {
    ...kept,
    CFBundleExecutable: name,
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIdentifier: bundleId,
    CFBundleIconFile: ICON_FILE,
  };
}

export function helperInfo(
  info: Plist,
  helperName: string,
  sourceBundleId: string,
  bundleId: string,
): Plist {
  const id = typeof info.CFBundleIdentifier === "string" ? info.CFBundleIdentifier : "";
  return {
    ...info,
    CFBundleExecutable: helperName,
    CFBundleName: helperName,
    CFBundleDisplayName: helperName,
    CFBundleIdentifier: id.startsWith(sourceBundleId)
      ? `${bundleId}${id.slice(sourceBundleId.length)}`
      : `${bundleId}.helper`,
  };
}

async function readPlist(file: string): Promise<Plist> {
  const { stdout } = await run(PLUTIL, ["-convert", "json", "-o", "-", file], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Plist;
}

async function writePlist(file: string, value: Plist) {
  await writeFile(file, JSON.stringify(value));
  await run(PLUTIL, ["-convert", "xml1", file]);
}

export async function readBundleVersion(bundle: string): Promise<string | null> {
  try {
    const info = await readPlist(path.join(bundle, "Contents", "Info.plist"));
    return typeof info.CFBundleShortVersionString === "string"
      ? info.CFBundleShortVersionString
      : null;
  } catch {
    return null;
  }
}

/**
 * Deletes a bundle or a folder holding one. Electron's `fs` treats `app.asar` inside it as a
 * folder and leaves it behind, so the system's own `rm` does it.
 */
export async function removeBundle(target: string) {
  await run("/bin/rm", ["-rf", target]);
}

/** An APFS clone shares the source's blocks; another volume gets a plain copy. */
async function cloneBundle(source: string, target: string) {
  try {
    await run("/bin/cp", ["-cR", source, target]);
  } catch {
    await removeBundle(target);
    await run("/bin/cp", ["-R", source, target]);
  }
}

async function sign(bundle: string) {
  await run(CODESIGN, ["--force", "--sign", "-", bundle], { timeout: 120_000 });
}

/**
 * A page app made from the running Rakazo at `target`: its own name, identity and icon, its
 * config beside Rakazo's code, and an ad-hoc signature, since the copy no longer matches
 * Rakazo's. Frameworks keep their signatures.
 */
export async function buildPageAppBundle(input: {
  source: string;
  target: string;
  name: string;
  bundleId: string;
  icon: Buffer;
  config: PageAppConfig;
}) {
  const { target, name, bundleId } = input;
  await cloneBundle(input.source, target);
  const contents = path.join(target, "Contents");
  const infoFile = path.join(contents, "Info.plist");
  const info = await readPlist(infoFile);
  const sourceName = String(info.CFBundleExecutable);
  const sourceId = String(info.CFBundleIdentifier);
  await Promise.all(
    UNUSED.map((entry) => rm(path.join(contents, entry), { recursive: true, force: true })),
  );
  const helpers = await Promise.all(
    HELPER_SUFFIXES.map(async (suffix) => {
      const from = path.join(contents, "Frameworks", `${sourceName} Helper${suffix}.app`);
      const helperName = `${name} Helper${suffix}`;
      const helper = path.join(contents, "Frameworks", `${helperName}.app`);
      await rename(from, helper);
      const macos = path.join(helper, "Contents", "MacOS");
      await rename(path.join(macos, `${sourceName} Helper${suffix}`), path.join(macos, helperName));
      const helperPlist = path.join(helper, "Contents", "Info.plist");
      await writePlist(
        helperPlist,
        helperInfo(await readPlist(helperPlist), helperName, sourceId, bundleId),
      );
      return helper;
    }),
  );
  await rename(path.join(contents, "MacOS", sourceName), path.join(contents, "MacOS", name));
  await writePlist(infoFile, pageAppInfo(info, name, bundleId));
  await writeFile(path.join(contents, "Resources", ICON_FILE), input.icon);
  await writeFile(
    path.join(contents, "Resources", PAGE_APP_CONFIG_FILE),
    `${JSON.stringify(input.config)}\n`,
  );
  await Promise.all(helpers.map(sign));
  await sign(target);
}

/** The icon and config an installed app was made with, to make it again from a newer Rakazo. */
export async function readBuiltApp(bundle: string) {
  const resources = path.join(bundle, "Contents", "Resources");
  const [icon, config] = await Promise.all([
    readFile(path.join(resources, ICON_FILE)),
    readFile(path.join(resources, PAGE_APP_CONFIG_FILE), "utf8"),
  ]);
  return { icon, config: JSON.parse(config) as unknown };
}

/** Tells Launch Services about the app now, so its name and icon show before the first open. */
export async function registerWithLaunchServices(bundle: string) {
  await run(LSREGISTER, ["-f", bundle]);
}

/** Unregisters a bundle about to be removed, so Launch Services forgets it at once. */
export async function unregisterFromLaunchServices(bundle: string) {
  await run(LSREGISTER, ["-u", bundle]);
}

/** The process ids of an app's main process running from this bundle. */
export async function runningAppPids(bundle: string): Promise<number[]> {
  const pattern = `^${path.join(bundle, "Contents", "MacOS").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-f", pattern]);
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    // pgrep exits 1 when nothing matches.
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}
