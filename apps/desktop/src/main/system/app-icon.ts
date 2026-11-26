import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppIcon } from "@rakazo/contracts";
import { DEFAULT_APP_ICON, isAppIcon } from "@rakazo/contracts";
import { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";

const APP_ICON_FILE_NAME = "app-icon.txt";

let current: AppIcon = DEFAULT_APP_ICON;

export function currentAppIcon(): AppIcon {
  return current;
}

export async function loadAppIcon(userDataDir: string): Promise<AppIcon> {
  const saved = (await readPrivateFile(path.join(userDataDir, APP_ICON_FILE_NAME), 64))?.trim();
  current = isAppIcon(saved) ? saved : DEFAULT_APP_ICON;
  return current;
}

async function saveAppIcon(userDataDir: string, icon: AppIcon) {
  await mkdir(userDataDir, { recursive: true });
  await writePrivateFile(path.join(userDataDir, APP_ICON_FILE_NAME), `${icon}\n`);
}

/** macOS draws the Dock file as-is, so it gets the rounded plate with Dock margins. */
export function appIconFile(dir: string, icon: AppIcon, platform: NodeJS.Platform): string {
  return path.join(dir, platform === "darwin" ? `${icon}-macos.png` : `${icon}.png`);
}

/** Applies before saving, so a choice that cannot be shown is never kept for the next launch. */
export function createAppIconSetHandler(
  userDataDir: string,
  apply: (icon: AppIcon) => void,
  report: (error: unknown) => void,
) {
  return async (_event: unknown, icon: unknown): Promise<boolean> => {
    if (!isAppIcon(icon)) return false;
    try {
      apply(icon);
    } catch (error) {
      report(error);
      return false;
    }
    try {
      await saveAppIcon(userDataDir, icon);
    } catch (error) {
      report(error);
      apply(current);
      return false;
    }
    current = icon;
    return true;
  };
}
