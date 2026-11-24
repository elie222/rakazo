import { isBotChatRouteId, isReservedAppSegment } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { BrowserWindow } from "electron";

export const DEEP_LINK_SCHEME = "rakazo";

const BOT_LINK = /^rakazo:\/\/app\/([^/?#]+)(?:[?#].*)?$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject raw controls before URL normalization.
const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f\s]/u;

export type ParsedDeepLink = {
  botId: string;
  search: string;
  hash: string;
};

/** Match the raw address before URL parsing can normalize path segments. */
export function parseDeepLink(raw: string): ParsedDeepLink | null {
  if (CONTROL_OR_WHITESPACE.test(raw)) return null;
  const botId = BOT_LINK.exec(raw)?.[1];
  if (botId === undefined || !isBotChatRouteId(botId) || isReservedAppSegment(botId.toLowerCase()))
    return null;
  const { search, hash } = new URL(raw);
  return { botId, search, hash };
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

  const base = URL.parse(currentTargetUrl);
  if (base === null || (base.protocol !== "http:" && base.protocol !== "https:")) return null;

  const target = new URL(base.origin);
  target.pathname = `/app/${deepLink.botId}`;
  target.search = deepLink.search;
  target.hash = deepLink.hash;
  return target.href;
}

function isNavigationAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === "ERR_ABORTED" || errno === -3;
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
  const contents = win.webContents;
  if (contents.getURL() === targetUrl && !contents.isLoadingMainFrame()) return true;
  void bestEffort(
    "navigate to desktop deep link",
    contents.loadURL(targetUrl).catch((error: unknown) => {
      if (isNavigationAbort(error)) return;
      throw error;
    }),
  );
  return true;
}
