import type { BrowserWindow } from "electron";

export const DEEP_LINK_SCHEME = "rakazo";

const SCHEME_PREFIX = `${DEEP_LINK_SCHEME}://`;
const APP_BOT_PATH = /^app\/([A-Za-z0-9_-]{1,200})$/i;
// Non-bot routes mounted under /app/* in the web router.
const RESERVED_APP_SEGMENTS = new Set(["artifacts", "board", "g", "x"]);

export type ParsedDeepLink = {
  kind: "bot";
  botId: string;
  search: string;
  hash: string;
};

function hasControlOrWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/.test(value);
}

/**
 * Parses an allowlisted `rakazo://` deep link (`rakazo://app/<botId>` with optional query/hash).
 * Rejects any other host, traversal segments, credentials, ports, or control characters.
 */
export function parseDeepLink(raw: string): ParsedDeepLink | null {
  if (typeof raw !== "string" || raw.length === 0 || hasControlOrWhitespace(raw)) return null;
  if (!raw.toLowerCase().startsWith(SCHEME_PREFIX)) return null;

  const withoutScheme = raw.slice(SCHEME_PREFIX.length);
  const queryOrHash = withoutScheme.search(/[?#]/);
  const authorityAndPath = queryOrHash === -1 ? withoutScheme : withoutScheme.slice(0, queryOrHash);
  const match = APP_BOT_PATH.exec(authorityAndPath);
  const botId = match?.[1];
  if (botId === undefined || RESERVED_APP_SEGMENTS.has(botId.toLowerCase())) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (url.hostname.toLowerCase() !== "app") return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.pathname !== `/${botId}`) return null;

  return {
    kind: "bot",
    botId,
    search: url.search,
    hash: url.hash,
  };
}

/** Extracts the last valid `rakazo://` deep link from process/second-instance arguments. */
export function extractDeepLinkFromArgv(argv: readonly string[]): ParsedDeepLink | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const parsed = parseDeepLink(arg);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Resolves a parsed deep link against the already-configured server origin.
 * A deep link never chooses or changes the target server origin.
 */
export function resolveDeepLinkTarget(
  deepLink: ParsedDeepLink,
  currentTargetUrl: string | null,
): string | null {
  if (currentTargetUrl === null) return null;

  let base: URL;
  try {
    base = new URL(currentTargetUrl);
  } catch {
    return null;
  }

  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.origin === "null") {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(
      `/app/${encodeURIComponent(deepLink.botId)}${deepLink.search}${deepLink.hash}`,
      base.origin,
    );
  } catch {
    return null;
  }

  if (resolved.origin !== base.origin) return null;
  return resolved.href;
}

/** Only packaged builds register the OS protocol handler so dev/test runs do not clobber it. */
export function shouldRegisterDeepLinkProtocol(isPackaged: boolean): boolean {
  return isPackaged;
}

/** Navigates the existing app window in place while preserving its session and partition. */
export function navigateWindowToDeepLink(
  win: BrowserWindow,
  deepLink: ParsedDeepLink,
  currentTargetUrl: string | null,
): boolean {
  if (win.isDestroyed()) return false;
  const targetUrl = resolveDeepLinkTarget(deepLink, currentTargetUrl);
  if (targetUrl === null) return false;
  if (win.webContents.getURL() === targetUrl) return true;
  void win.webContents.loadURL(targetUrl).catch(() => undefined);
  return true;
}
