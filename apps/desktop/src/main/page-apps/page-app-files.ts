import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PAGE_APP_TOKEN } from "@rakazo/contracts";
import { PAGE_APP_ID } from "./bundle-name.js";

/**
 * Written into each app's bundle on macOS, where its presence is what starts the bundle as a page
 * app, and into the app's data folder elsewhere.
 */
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

/** Whether an origin is this computer's own, as Rakazo's local server is. */
export function isLoopbackOrigin(origin: string): boolean {
  const host = URL.parse(origin)?.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

const SERVER_FILE = "server";

/**
 * The server an app reads instead of the one in its bundle, kept with its data because a signed
 * bundle cannot change: Rakazo's local server can move to another port between starts.
 */
export function readServerOverride(appId: string, appData: string): string | null {
  try {
    return serverOrigin(
      readFileSync(path.join(pageAppDataDir(appId, appData), SERVER_FILE), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeServerOverride(appId: string, server: string, appData: string) {
  await mkdir(pageAppDataDir(appId, appData), { recursive: true, mode: 0o700 });
  await writeFile(path.join(pageAppDataDir(appId, appData), SERVER_FILE), `${server}\n`, {
    mode: 0o600,
  });
}

export function pageAppsFolder(home = os.homedir()): string {
  return path.join(home, "Applications", "Rakazo Apps");
}

/** Where every app keeps its own data, inside the system's app data folder (Electron's `appData`). */
export function pageAppsDataDir(appData: string): string {
  return path.join(appData, "Rakazo Apps");
}

/** An app's own data: its token and its window's browser data. */
export function pageAppDataDir(appId: string, appData: string): string {
  if (!PAGE_APP_ID.test(appId)) throw new Error("Invalid page app id.");
  return path.join(pageAppsDataDir(appData), appId);
}

export function pageAppTokenFile(appId: string, appData: string) {
  return path.join(pageAppDataDir(appId, appData), "token");
}

/** The user's own folder is private on every platform; the modes also keep it so on macOS and Linux. */
export async function writePageAppToken(appId: string, token: string, appData: string) {
  await mkdir(pageAppDataDir(appId, appData), { recursive: true, mode: 0o700 });
  await writeFile(pageAppTokenFile(appId, appData), token, { encoding: "utf8", mode: 0o600 });
}

/** Null when the app has no token: it was uninstalled, or its data was removed. */
export async function readPageAppToken(appId: string, appData: string): Promise<string | null> {
  try {
    const token = (await readFile(pageAppTokenFile(appId, appData), "utf8")).trim();
    return PAGE_APP_TOKEN.test(token) ? token : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const HEADERS_FILE = "headers.json";

/**
 * Headers the app's server requires on every request (an access proxy's credentials, say), kept
 * beside the token and as private, since an app is its own process outside Rakazo's session.
 */
export async function writePageAppHeaders(
  appId: string,
  headers: Record<string, string>,
  appData: string,
) {
  if (Object.keys(headers).length === 0) return;
  await mkdir(pageAppDataDir(appId, appData), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(pageAppDataDir(appId, appData), HEADERS_FILE),
    JSON.stringify(headers),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

export async function readPageAppHeaders(
  appId: string,
  appData: string,
): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path.join(pageAppDataDir(appId, appData), HEADERS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function removePageAppData(appId: string, appData: string) {
  await rm(pageAppDataDir(appId, appData), { recursive: true, force: true });
}
