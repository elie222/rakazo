import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PAGE_APP_TOKEN } from "@rakazo/contracts";
import { PAGE_APP_ID } from "./bundle-name.js";

/** Written into each app's bundle; its presence is what starts the bundle as a page app. */
export const PAGE_APP_CONFIG_FILE = "page-app.json";

export type PageAppConfig = {
  appId: string;
  pageId: string;
  title: string;
  /** The origin of the Rakazo server that made the app's token. */
  server: string;
};

const PAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** An http(s) origin, or null. */
export function serverOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : null;
}

/** Whether these name one page app in a way that is safe in paths, identifiers and menus. */
export function isPageAppIdentity(appId: unknown, pageId: unknown, title: unknown): boolean {
  return (
    typeof appId === "string" &&
    PAGE_APP_ID.test(appId) &&
    typeof pageId === "string" &&
    PAGE_ID.test(pageId) &&
    typeof title === "string" &&
    title.length > 0 &&
    title.length <= 200
  );
}

/** The config's fields when every one is usable; null otherwise. */
export function pageAppConfig(value: unknown): PageAppConfig | null {
  if (!value || typeof value !== "object") return null;
  const { appId, pageId, title, server } = value as Record<string, unknown>;
  const origin = serverOrigin(server);
  return isPageAppIdentity(appId, pageId, title) && origin !== null
    ? { appId: appId as string, pageId: pageId as string, title: title as string, server: origin }
    : null;
}

export function pageAppsFolder(home = os.homedir()): string {
  return path.join(home, "Applications", "Rakazo Apps");
}

/** An app's own data: its token and its window's browser data. */
export function pageAppDataDir(appId: string, home = os.homedir()): string {
  if (!PAGE_APP_ID.test(appId)) throw new Error("Invalid page app id.");
  return path.join(home, "Library", "Application Support", "Rakazo Apps", appId);
}

function tokenFile(appId: string, home?: string) {
  return path.join(pageAppDataDir(appId, home), "token");
}

export async function writePageAppToken(appId: string, token: string, home?: string) {
  await mkdir(pageAppDataDir(appId, home), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(appId, home), token, { encoding: "utf8", mode: 0o600 });
}

/** Null when the app has no token: it was uninstalled, or its data was removed. */
export async function readPageAppToken(appId: string, home?: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenFile(appId, home), "utf8")).trim();
    return PAGE_APP_TOKEN.test(token) ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removePageAppData(appId: string, home?: string) {
  await rm(pageAppDataDir(appId, home), { recursive: true, force: true });
}
