import { sha1Hex, utf8Bytes } from "./backup-crypto";

/**
 * WebDAV backup: the pure, testable half. No React Native import at the top
 * level, so tests run it in plain Node. The native file transfers live in
 * webdav-backup-transfer.ts; the account store in webdav-backup-account.ts.
 *
 * Client choice: hand-written, not the `webdav` npm package. The client only
 * needs PROPFIND (status + a list of `d:href`s), MKCOL, PUT and GET, and a
 * hand-rolled client keeps the WebDAV password in one Authorization header
 * instead of trusting a package's URL handling — a package that builds
 * `https://user:pass@host/` URLs would put the password in logs. It also
 * avoids a new dependency and its dynamic-import dance in the RN bundle.
 */

export const WEBDAV_BACKUP_DIRECTORY_DEFAULT = "rakazo-backup";
export const WEBDAV_BACKUP_ZIP_NAME = "rakazo-backup.zip";
export const WEBDAV_BACKUP_MANIFEST_NAME = "rakazo-backup.json";
export const WEBDAV_BACKUP_SETTINGS_NAME = "rakazo-settings.json";
export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_SETTINGS_VERSION = 1;
export const BACKUP_PASSWORD_MIN_LENGTH = 12;
export const BACKUP_PASSWORD_RECOMMENDED_LENGTH = 16;

export type WebdavBackupErrorCode =
  | "https-required"
  | "invalid-url"
  | "credentials-in-url"
  | "invalid-directory"
  | "auth"
  | "parent-missing"
  | "not-found"
  | "server-error"
  | "unreachable"
  | "export-failed"
  | "export-expired"
  | "import-failed"
  | "conflict"
  | "cancelled";

/**
 * Fixed-message errors only: no URL, server body, or credential ever lands in
 * a message, so a password cannot leak through a log line or an alert.
 */
export class WebdavBackupError extends Error {
  readonly code: WebdavBackupErrorCode;

  constructor(code: WebdavBackupErrorCode) {
    super(code);
    this.code = code;
  }
}

export type WebdavBackupAccount = {
  /** https origin, no trailing slash, no credentials in the URL. */
  serverUrl: string;
  username: string;
  /** The WebDAV account password. The backup password is never stored. */
  password: string;
  /** Raw directory segments, e.g. ["rakazo-backup"]. */
  directory: string;
};

/** Standard base64, for the Basic Authorization header. */
export function base64Encode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const first = bytes[i]!;
    const second = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const third = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += alphabet[first >> 2];
    out += alphabet[((first & 0x03) << 4) | (second >> 4)];
    out += i + 1 < bytes.length ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : "=";
    out += i + 2 < bytes.length ? alphabet[third & 0x3f] : "=";
  }
  return out;
}

/** The password travels only in this header, never in a URL. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${base64Encode(utf8Bytes(`${username}:${password}`))}`;
}

/**
 * Normalizes a WebDAV server address. Only https is accepted: a backup
 * password sent over http would travel in the clear. Credentials in the URL
 * are refused outright.
 */
export function normalizeWebdavServerUrl(
  input: string,
): { ok: true; serverUrl: string } | { ok: false; error: WebdavBackupErrorCode } {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid-url" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "https-required" };
  if (url.username || url.password) return { ok: false, error: "credentials-in-url" };
  if (url.search || url.hash) return { ok: false, error: "invalid-url" };
  return { ok: true, serverUrl: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * Sanitizes a backup directory. `..`, a leading `/`, backslashes, and empty
 * segments are all refused; each segment is percent-encoded when a URL is
 * built, never trusted raw.
 */
export function sanitizeBackupDirectory(
  input: string,
): { ok: true; segments: string[] } | { ok: false; error: "invalid-directory" } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, segments: [WEBDAV_BACKUP_DIRECTORY_DEFAULT] };
  if (trimmed.startsWith("/") || trimmed.includes("\\"))
    return { ok: false, error: "invalid-directory" };
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, error: "invalid-directory" };
    }
  }
  return { ok: true, segments };
}

/** A directory URL with every segment percent-encoded, and no credentials. */
export function webdavUrl(base: string, segments: string[], fileName?: string): string {
  const parts = [...segments, ...(fileName ? [fileName] : [])].map((part) =>
    encodeURIComponent(part),
  );
  return `${base}/${parts.join("/")}`;
}

/** `d:href` values out of a PROPFIND multistatus body, percent-decoded. */
export function parsePropfindHrefs(xml: string): string[] {
  const hrefs: string[] = [];
  const pattern = /<[^>]*:?href>([^<]*)<\/[^>]*:?href>/gi;
  for (;;) {
    const match = pattern.exec(xml);
    if (match === null) break;
    const raw = match[1]!.trim();
    try {
      hrefs.push(decodeURIComponent(raw));
    } catch {
      hrefs.push(raw);
    }
  }
  return hrefs;
}

export type WebdavResponse = {
  status: number;
  text: () => Promise<string>;
};

export type WebdavFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<WebdavResponse>;

async function defaultWebdavFetch(
  url: string,
  init: Parameters<WebdavFetch>[1],
): Promise<WebdavResponse> {
  const response = await fetch(url, { ...init, redirect: "error" });
  return { status: response.status, text: () => response.text() };
}

async function propfind(
  account: WebdavBackupAccount,
  segments: string[],
  depth: "0" | "1",
  fetchImpl: WebdavFetch,
): Promise<WebdavResponse> {
  const normalized = normalizeWebdavServerUrl(account.serverUrl);
  if (!normalized.ok) throw new WebdavBackupError(normalized.error);
  const directory = sanitizeBackupDirectory(account.directory);
  if (!directory.ok) throw new WebdavBackupError(directory.error);
  return fetchImpl(webdavUrl(normalized.serverUrl, segments), {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuthHeader(account.username, account.password),
      Depth: depth,
    },
  });
}

export type WebdavConnectionTest =
  | { status: "ok" }
  | { status: "auth-error" }
  | { status: "missing-directory" }
  | { status: "server-error" }
  | { status: "unreachable" };

/**
 * PROPFIND Depth:0 on the backup directory. 207 means the directory is
 * there, 401 means the password is wrong, 404 means the login worked but
 * the directory does not exist yet.
 */
export async function testWebdavConnection(
  account: WebdavBackupAccount,
  fetchImpl: WebdavFetch = defaultWebdavFetch,
): Promise<WebdavConnectionTest> {
  let response: WebdavResponse;
  try {
    const directory = sanitizeBackupDirectory(account.directory);
    if (!directory.ok) return { status: "server-error" };
    response = await propfind(account, directory.segments, "0", fetchImpl);
  } catch (error) {
    if (error instanceof WebdavBackupError) return { status: "server-error" };
    return { status: "unreachable" };
  }
  if (response.status === 207) return { status: "ok" };
  if (response.status === 401 || response.status === 403) return { status: "auth-error" };
  if (response.status === 404) return { status: "missing-directory" };
  return { status: "server-error" };
}

/**
 * Makes sure the backup directory exists: PROPFIND first, MKCOL on a 404.
 * A 405 from MKCOL means it already exists; a 409 means a parent directory
 * is missing; 401/403 stop with an auth error.
 */
export async function ensureWebdavDirectory(
  account: WebdavBackupAccount,
  fetchImpl: WebdavFetch = defaultWebdavFetch,
): Promise<void> {
  const directory = sanitizeBackupDirectory(account.directory);
  if (!directory.ok) throw new WebdavBackupError(directory.error);
  const normalized = normalizeWebdavServerUrl(account.serverUrl);
  if (!normalized.ok) throw new WebdavBackupError(normalized.error);
  const headers = { Authorization: basicAuthHeader(account.username, account.password) };
  let response: WebdavResponse;
  try {
    response = await propfind(account, directory.segments, "0", fetchImpl);
  } catch {
    throw new WebdavBackupError("unreachable");
  }
  if (response.status === 207) return;
  if (response.status === 401 || response.status === 403) throw new WebdavBackupError("auth");
  if (response.status !== 404) throw new WebdavBackupError("server-error");
  let created: WebdavResponse;
  try {
    created = await fetchImpl(webdavUrl(normalized.serverUrl, directory.segments), {
      method: "MKCOL",
      headers,
    });
  } catch {
    throw new WebdavBackupError("unreachable");
  }
  if (created.status === 201 || created.status === 204 || created.status === 405) return;
  if (created.status === 409) throw new WebdavBackupError("parent-missing");
  if (created.status === 401 || created.status === 403) throw new WebdavBackupError("auth");
  throw new WebdavBackupError("server-error");
}

/** File names directly inside the backup directory, from a Depth:1 listing. */
export async function listWebdavDirectory(
  account: WebdavBackupAccount,
  fetchImpl: WebdavFetch = defaultWebdavFetch,
): Promise<string[]> {
  const directory = sanitizeBackupDirectory(account.directory);
  if (!directory.ok) throw new WebdavBackupError(directory.error);
  let response: WebdavResponse;
  try {
    response = await propfind(account, directory.segments, "1", fetchImpl);
  } catch {
    throw new WebdavBackupError("unreachable");
  }
  if (response.status === 401 || response.status === 403) throw new WebdavBackupError("auth");
  if (response.status !== 207) throw new WebdavBackupError("server-error");
  const normalized = normalizeWebdavServerUrl(account.serverUrl);
  if (!normalized.ok) throw new WebdavBackupError(normalized.error);
  // The directory's own path, so a server mounted under a prefix
  // (https://host/dav/rakazo-backup/) still lists correctly.
  const directoryPath = new URL(
    webdavUrl(normalized.serverUrl, directory.segments),
  ).pathname.replace(/\/+$/, "");
  const hrefs = parsePropfindHrefs(await response.text());
  const names = new Set<string>();
  for (const href of hrefs) {
    let path: string;
    try {
      path = new URL(href, "https://webdav.invalid").pathname;
    } catch {
      continue;
    }
    const decoded = (() => {
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    })().replace(/\/+$/, "");
    if (!decoded.startsWith(`${directoryPath}/`)) continue;
    const rest = decoded.slice(directoryPath.length + 1);
    if (rest && !rest.includes("/")) names.add(rest);
  }
  return [...names];
}

/** Small text file up to the backup directory (manifest, settings). */
export async function putWebdavTextFile(
  account: WebdavBackupAccount,
  fileName: string,
  content: string,
  contentType: string,
  fetchImpl: WebdavFetch = defaultWebdavFetch,
): Promise<void> {
  const directory = sanitizeBackupDirectory(account.directory);
  if (!directory.ok) throw new WebdavBackupError(directory.error);
  const normalized = normalizeWebdavServerUrl(account.serverUrl);
  if (!normalized.ok) throw new WebdavBackupError(normalized.error);
  let response: WebdavResponse;
  try {
    response = await fetchImpl(webdavUrl(normalized.serverUrl, directory.segments, fileName), {
      method: "PUT",
      headers: {
        Authorization: basicAuthHeader(account.username, account.password),
        "content-type": contentType,
      },
      body: content,
    });
  } catch {
    throw new WebdavBackupError("unreachable");
  }
  if (response.status === 401 || response.status === 403) throw new WebdavBackupError("auth");
  if (response.status < 200 || response.status >= 300) throw new WebdavBackupError("server-error");
}

/** Small text file down from the backup directory; null when it is not there. */
export async function getWebdavTextFile(
  account: WebdavBackupAccount,
  fileName: string,
  fetchImpl: WebdavFetch = defaultWebdavFetch,
): Promise<string | null> {
  const directory = sanitizeBackupDirectory(account.directory);
  if (!directory.ok) throw new WebdavBackupError(directory.error);
  const normalized = normalizeWebdavServerUrl(account.serverUrl);
  if (!normalized.ok) throw new WebdavBackupError(normalized.error);
  let response: WebdavResponse;
  try {
    response = await fetchImpl(webdavUrl(normalized.serverUrl, directory.segments, fileName), {
      method: "GET",
      headers: { Authorization: basicAuthHeader(account.username, account.password) },
    });
  } catch {
    throw new WebdavBackupError("unreachable");
  }
  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) throw new WebdavBackupError("auth");
  if (response.status !== 200) throw new WebdavBackupError("server-error");
  return response.text();
}

export type BackupManifest = {
  version: 1;
  exportedAt: string;
  size: number;
  sha256: string;
};

export function buildBackupManifest(input: {
  size: number;
  sha256: string;
  exportedAt?: Date;
}): BackupManifest {
  return {
    version: BACKUP_MANIFEST_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    size: input.size,
    sha256: input.sha256,
  };
}

export function parseBackupManifest(value: unknown): BackupManifest | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.version !== BACKUP_MANIFEST_VERSION) return null;
  if (typeof item.exportedAt !== "string" || Number.isNaN(Date.parse(item.exportedAt))) return null;
  if (typeof item.size !== "number" || !Number.isInteger(item.size) || item.size < 0) return null;
  if (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) return null;
  return {
    version: BACKUP_MANIFEST_VERSION,
    exportedAt: item.exportedAt,
    size: item.size,
    sha256: item.sha256,
  };
}

export type BackupSideState = {
  exists: boolean;
  updatedAt: string | null;
  size: number | null;
  sha256: string | null;
};

export type SyncDecision = "upload" | "download" | "in-sync" | "conflict" | "nothing";

/**
 * Manual two-way sync, v1. A side only counts as changed when its timestamp
 * moved past the last sync; when both sides changed, or when neither can be
 * told apart, the answer is "conflict" and the user picks a direction —
 * sync never silently overwrites.
 */
export function decideSync(
  local: BackupSideState,
  remote: BackupSideState,
  lastSyncedAt: string | null,
): SyncDecision {
  if (!local.exists && !remote.exists) return "nothing";
  if (local.exists && !remote.exists) return "upload";
  if (!local.exists && remote.exists) return "download";
  if (local.sha256 && remote.sha256) {
    // Both sides report a hash: only an equal hash means in sync. A
    // matching size and timestamp with different hashes is not.
    if (local.sha256 === remote.sha256) return "in-sync";
  } else if (
    local.size !== null &&
    remote.size !== null &&
    local.size === remote.size &&
    local.updatedAt !== null &&
    remote.updatedAt !== null &&
    local.updatedAt === remote.updatedAt
  ) {
    // No hash on one side (an older manifest): size plus timestamp is the
    // only comparison available.
    return "in-sync";
  }
  const last = lastSyncedAt === null ? null : Date.parse(lastSyncedAt);
  if (last !== null && !Number.isNaN(last)) {
    const localTime = local.updatedAt === null ? null : Date.parse(local.updatedAt);
    const remoteTime = remote.updatedAt === null ? null : Date.parse(remote.updatedAt);
    const localChanged = localTime === null || localTime > last;
    const remoteChanged = remoteTime === null || remoteTime > last;
    if (localChanged && !remoteChanged) return "upload";
    if (remoteChanged && !localChanged) return "download";
    if (!localChanged && !remoteChanged) return "conflict";
    return "conflict";
  }
  return "conflict";
}

export type BackupBackgroundValue = {
  kind: "image" | "url" | "video";
  uri: string;
  opacity: number;
  name?: string;
};

function isBackupBackgroundValue(value: unknown): value is BackupBackgroundValue {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "image" || item.kind === "url" || item.kind === "video") &&
    typeof item.uri === "string" &&
    typeof item.opacity === "number"
  );
}

export type BackupSettingsFile = {
  version: 1;
  exportedAt: string;
  userId: string;
  settings: {
    heroBackground: Record<string, BackupBackgroundValue> | null;
    chatBackgrounds: Record<string, BackupBackgroundValue>;
    expressionPack: "chief" | "off";
    custom: Record<string, unknown>;
  };
};

/**
 * The settings file carries only appearance settings. It is built from the
 * three known maps plus the interface settings, so a WebDAV password, an
 * account password, or a backup password can never end up in it — there is
 * no field for one. Font files stay on this device; only their names travel
 * inside `custom`.
 */
export function buildBackupSettingsFile(input: {
  userId: string;
  heroBackground: Record<string, BackupBackgroundValue>;
  chatBackgrounds: Record<string, BackupBackgroundValue>;
  expressionPack: "chief" | "off";
  /** The interface settings snapshot; an empty object keeps old files unchanged. */
  custom?: Record<string, unknown>;
  exportedAt?: Date;
}): BackupSettingsFile {
  const heroEntries = Object.entries(input.heroBackground).filter(([, value]) =>
    isBackupBackgroundValue(value),
  );
  const chatEntries = Object.entries(input.chatBackgrounds).filter(([, value]) =>
    isBackupBackgroundValue(value),
  );
  return {
    version: BACKUP_SETTINGS_VERSION,
    exportedAt: (input.exportedAt ?? new Date()).toISOString(),
    userId: input.userId,
    settings: {
      heroBackground: heroEntries.length > 0 ? Object.fromEntries(heroEntries) : null,
      chatBackgrounds: Object.fromEntries(chatEntries),
      expressionPack: input.expressionPack,
      custom: input.custom ?? {},
    },
  };
}

export function parseBackupSettingsFile(value: unknown): BackupSettingsFile | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.version !== BACKUP_SETTINGS_VERSION) return null;
  if (typeof item.exportedAt !== "string" || Number.isNaN(Date.parse(item.exportedAt))) return null;
  if (typeof item.userId !== "string" || item.userId === "") return null;
  if (!item.settings || typeof item.settings !== "object") return null;
  const settings = item.settings as Record<string, unknown>;
  const settingKeys = Object.keys(settings);
  if (
    settingKeys.length !== 4 ||
    !settingKeys.includes("heroBackground") ||
    !settingKeys.includes("chatBackgrounds") ||
    !settingKeys.includes("expressionPack") ||
    !settingKeys.includes("custom")
  ) {
    return null;
  }
  const heroRaw = settings.heroBackground;
  let heroBackground: Record<string, BackupBackgroundValue> | null = null;
  if (heroRaw !== null) {
    if (!heroRaw || typeof heroRaw !== "object" || Array.isArray(heroRaw)) return null;
    heroBackground = {};
    for (const [key, entry] of Object.entries(heroRaw)) {
      if (!isBackupBackgroundValue(entry)) return null;
      heroBackground[key] = entry;
    }
  }
  const chatRaw = settings.chatBackgrounds;
  if (!chatRaw || typeof chatRaw !== "object" || Array.isArray(chatRaw)) return null;
  const chatBackgrounds: Record<string, BackupBackgroundValue> = {};
  for (const [key, entry] of Object.entries(chatRaw)) {
    if (!isBackupBackgroundValue(entry)) return null;
    chatBackgrounds[key] = entry;
  }
  if (settings.expressionPack !== "chief" && settings.expressionPack !== "off") return null;
  if (!settings.custom || typeof settings.custom !== "object" || Array.isArray(settings.custom)) {
    return null;
  }
  return {
    version: BACKUP_SETTINGS_VERSION,
    exportedAt: item.exportedAt,
    userId: item.userId,
    settings: {
      heroBackground,
      chatBackgrounds,
      expressionPack: settings.expressionPack,
      custom: settings.custom as Record<string, unknown>,
    },
  };
}

export type BackupPasswordProblem = "too-short" | "same-as-account" | null;

/** At least 12 characters, and never the same as the account password. */
export function validateBackupPassword(
  password: string,
  accountPassword?: string,
): BackupPasswordProblem {
  if (password.length < BACKUP_PASSWORD_MIN_LENGTH) return "too-short";
  if (accountPassword !== undefined && accountPassword !== "" && password === accountPassword) {
    return "same-as-account";
  }
  return null;
}

type HibpFetch = (url: string) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * The breached-password check, same k-anonymity shape as the server's: only
 * the first five SHA-1 hex characters leave the device. Fails open — a
 * network error never blocks setting a backup password.
 */
export async function isBackupPasswordBreached(
  password: string,
  fetchImpl: HibpFetch = fetch,
): Promise<boolean> {
  const hash = sha1Hex(password).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (response.status !== 200) return false;
    const body = await response.text();
    return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
  } catch {
    return false;
  }
}
