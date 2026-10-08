/// <reference path="./linkify-it.d.ts" />
import LinkifyIt from "linkify-it";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
};

type LinkifyRules = {
  set(options: { fuzzyLink: boolean }): unknown;
  add(schema: string, definition: null): unknown;
};

type LinkifyParser = {
  set(options: { linkify: boolean }): unknown;
  linkify: LinkifyRules;
};

type ExplicitLinkMatch = {
  index: number;
  lastIndex: number;
  url: string;
};

type ExplicitLinkify = LinkifyRules & {
  match(text: string): ExplicitLinkMatch[] | null;
};

function applyExplicitLinkRules(linkify: LinkifyRules) {
  linkify.set({ fuzzyLink: false });
  linkify.add("ftp:", null);
  linkify.add("//", null);
}

/**
 * Turn bare http(s) URLs and email addresses into links, as the web renderer's GFM autolinks
 * do. Bare domains stay text: fuzzy matching would also link file names like setup.py or
 * notes.md. ftp: and protocol-relative URLs stay text because sanitizeMarkdownUrl would not
 * open them.
 */
export function linkifyExplicitUrls<T extends LinkifyParser>(parser: T): T {
  parser.set({ linkify: true });
  applyExplicitLinkRules(parser.linkify);
  return parser;
}

const plainTextLinkify: ExplicitLinkify = new LinkifyIt();
applyExplicitLinkRules(plainTextLinkify);

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export type PlainTextPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

function appendPlainText(parts: PlainTextPart[], value: string) {
  if (!value) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }
  parts.push({ type: "text", value });
}

/**
 * Split plain user-message text into literal runs and tappable links.
 * User bubbles stay plain text on web and mobile. Bold, headings, and other
 * markdown remain characters. Links use the same explicit autolinker as bot
 * messages, so a balanced parenthesis stays inside the URL and a closing
 * parenthesis that only wraps the surrounding prose does not.
 */
export function plainTextLinkParts(text: string): PlainTextPart[] {
  const matches = plainTextLinkify.match(text);
  if (!matches || matches.length === 0) return [{ type: "text", value: text }];

  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor || match.lastIndex <= match.index) continue;
    const value = text.slice(match.index, match.lastIndex);
    const href = sanitizeMarkdownUrl(match.url);
    appendPlainText(parts, text.slice(cursor, match.index));
    if (!href) {
      appendPlainText(parts, value);
      cursor = match.lastIndex;
      continue;
    }
    parts.push({ type: "link", value, href });
    cursor = match.lastIndex;
  }

  appendPlainText(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

const httpUrlProtocols = new Set(["http:", "https:"]);

function markdownLinkBase(appOrigin?: string | null) {
  if (!appOrigin) return "https://app.invalid";
  try {
    return new URL(appOrigin).origin;
  } catch {
    return "https://app.invalid";
  }
}

export function markdownLinkRequiresConfirmation(url: string, appOrigin?: string | null): boolean {
  const value = url.trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, markdownLinkBase(appOrigin));
  } catch {
    return false;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return false;
  const explicitDestination = /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
  if (!explicitDestination) return false;
  if (!appOrigin) return true;
  try {
    return parsed.origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

export type MarkdownLinkDisplayParts = {
  before: string;
  host: string;
  after: string;
};

export function markdownLinkDisplayParts(url: string): MarkdownLinkDisplayParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return undefined;
  const href = parsed.href;
  const authorityAt = href.indexOf("//") + 2;
  const userinfoLength =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`.length
      : 0;
  const hostAt = authorityAt + userinfoLength;
  return {
    before: href.slice(0, hostAt),
    host: parsed.host,
    after: href.slice(hostAt + parsed.host.length),
  };
}

const imageLinkProtocols = new Set(["http", "https"]);

export function sanitizeMarkdownImageUrl(url: string): string | undefined {
  const href = sanitizeMarkdownUrl(url);
  if (!href) return undefined;
  const protocol = href.match(protocolPattern)?.[1]?.toLowerCase();
  return protocol && imageLinkProtocols.has(protocol) ? href : undefined;
}

const inlineImagePattern = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z\d+/=]+$/i;
const MAX_INLINE_IMAGE_URL_LENGTH = 1024 * 1024;

/**
 * Markdown images in bot output never fetch on their own: an image URL can carry conversation
 * data to any host the moment a reply renders. Only embedded raster data renders at once; a
 * remote image waits for the reader's tap unless they turned on loading web images.
 */
export function inlineMarkdownImageSrc(url: string): string | undefined {
  const value = url.trim();
  return value.length <= MAX_INLINE_IMAGE_URL_LENGTH && inlineImagePattern.test(value)
    ? value
    : undefined;
}

/** A markdown image that may load on request, with the host its placeholder names. */
export function remoteMarkdownImage(url: string): { href: string; host: string } | undefined {
  const href = sanitizeMarkdownImageUrl(url);
  if (!href) return undefined;
  try {
    return { href, host: new URL(href).host };
  } catch {
    return undefined;
  }
}

/** Whether remote markdown images load without a tap. Apps provide the reader's device setting. */
export const RemoteImagesContext = createContext(false);

// Images the reader chose to load stay loaded for the session, even after a bubble remounts.
const loadedRemoteImages = new Set<string>();

export function remoteImageLoaded(href: string): boolean {
  return loadedRemoteImages.has(href);
}

/** The current URL only. A link that cannot open stays text, so its image is not requested. */
export function remoteImageRenders(
  href: string,
  loadRemote: boolean,
  rejectedLink: boolean,
): boolean {
  return !rejectedLink && (loadRemote || remoteImageLoaded(href));
}

export function markRemoteImageLoaded(href: string): void {
  loadedRemoteImages.add(href);
}

const SHORT_LINK_LABEL_MAX = 40;
const SHORT_LINK_PATH_MIN = 12;
// Control and format characters (bidi overrides, zero-width joiners and spaces, the BOM) that a
// decoded path could use to disguise itself.
const HIDDEN_PATH_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function httpUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodedUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function comparableUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * The words a link shows. An author's label stays as written; a bare URL (an autolink, or a
 * label that just repeats the address) shortens to host and path, like `x.com/elonmusk`. The
 * host is what tells a reader where the link goes, so it is never cut and stays in its ASCII
 * (punycode) form; only a long path is trimmed.
 */
export function linkLabel(text: string, href: string): string {
  const url = httpUrl(href);
  // Some parsers show an autolink with its escapes decoded (`caf%C3%A9` as `café`), so a label
  // that matches the decoded address is bare too.
  const label = comparableUrl(text);
  if (!url || (label !== comparableUrl(href) && label !== comparableUrl(decodedUrl(href)))) {
    return text;
  }
  const host = url.host.replace(/^www\./i, "");
  const path = decodedUrl(url.pathname.replace(/\/+$/, "")).replace(HIDDEN_PATH_CHARACTERS, "");
  const room = Math.max(SHORT_LINK_LABEL_MAX - host.length, SHORT_LINK_PATH_MIN);
  return path.length > room ? `${host}${path.slice(0, room - 1)}…` : `${host}${path}`;
}

/** The origin a link's site icon is looked up by, or undefined for links that get no icon. */
export function linkFaviconOrigin(href: string): string | undefined {
  return httpUrl(href)?.origin;
}

/**
 * Where link icons come from. Apps load them through the Rakazo API, which fetches and caches
 * them, so a device never contacts the linked site or an icon service. `globe` is the native
 * fallback glyph; web draws its own.
 */
export type LinkFavicons = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the site has no icon. */
  load(origin: string): Promise<{ icon: string | null; retry?: boolean }>;
  globe?: ReactNode;
};

export const LinkFaviconsContext = createContext<LinkFavicons | null>(null);

/** True while a reply streams: a half-written autolink host must not be looked up. */
export const LinkFaviconsPausedContext = createContext(false);

// One answer per API endpoint and origin for the session, shared by links on screen.
const linkFavicons = new Map<string, string | null>();
const pendingFavicons = new Set<string>();
// A failed lookup (an older server without the procedure, or no connection) is not asked again
// by every link that mounts, but is retried after a while so a brief outage does not last all day.
const FAILED_FAVICON_RETRY_MS = 5 * 60 * 1000;
const failedFavicons = new Map<string, number>();
// A busy server is asked again a few times, a little later, while the link stays on screen.
const BUSY_FAVICON_RETRY_MS = 10_000;
const BUSY_FAVICON_ATTEMPTS = 3;
const busyFaviconRetries = new Map<string, ReturnType<typeof setTimeout>>();
// How many links to each origin are on screen; a busy retry stops once none are.
const mountedFaviconLinks = new Map<string, number>();
const faviconListeners = new Set<() => void>();

function setLinkFavicon(origin: string, icon: string | null) {
  linkFavicons.set(origin, icon);
  for (const listener of faviconListeners) listener();
}

function subscribeLinkFavicons(listener: () => void) {
  faviconListeners.add(listener);
  return () => {
    faviconListeners.delete(listener);
  };
}

/** The origin stays pending across busy retries, so links that mount meanwhile do not ask too. */
function requestLinkFavicon(source: LinkFavicons, origin: string, key: string, attempt: number) {
  pendingFavicons.add(key);
  source.load(origin).then(
    (answer) => {
      const shown = mountedFaviconLinks.has(key);
      if (answer.retry && shown && attempt < BUSY_FAVICON_ATTEMPTS) {
        const retry = () => {
          busyFaviconRetries.delete(key);
          requestLinkFavicon(source, origin, key, attempt + 1);
        };
        busyFaviconRetries.set(key, setTimeout(retry, BUSY_FAVICON_RETRY_MS));
        return;
      }
      pendingFavicons.delete(key);
      // A busy answer for links no longer on screen is dropped; the next one to mount asks.
      if (answer.retry && shown) failedFavicons.set(key, Date.now());
      else if (!answer.retry) setLinkFavicon(key, answer.icon);
    },
    () => {
      pendingFavicons.delete(key);
      failedFavicons.set(key, Date.now());
    },
  );
}

/** The icon for a link once the API has one, and a way to drop an image that turns out unusable. */
export function useLinkFavicon(href: string): { icon: string | null; unusable: () => void } {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const origin = linkFaviconOrigin(href);
  const key = JSON.stringify([source?.endpoint ?? "", origin]);
  const snapshot = () => (origin ? (linkFavicons.get(key) ?? null) : null);
  const icon = useSyncExternalStore(subscribeLinkFavicons, snapshot, snapshot);
  useEffect(() => {
    if (!origin) return;
    mountedFaviconLinks.set(key, (mountedFaviconLinks.get(key) ?? 0) + 1);
    return () => {
      const left = (mountedFaviconLinks.get(key) ?? 1) - 1;
      if (left > 0) {
        mountedFaviconLinks.set(key, left);
        return;
      }
      mountedFaviconLinks.delete(key);
      const retry = busyFaviconRetries.get(key);
      if (retry === undefined) return;
      clearTimeout(retry);
      busyFaviconRetries.delete(key);
      pendingFavicons.delete(key);
    };
  }, [key, origin]);
  useEffect(() => {
    if (!source || paused || !origin) return;
    if (linkFavicons.has(key) || pendingFavicons.has(key)) return;
    if (Date.now() - (failedFavicons.get(key) ?? -Infinity) < FAILED_FAVICON_RETRY_MS) return;
    requestLinkFavicon(source, origin, key, 1);
  }, [source, paused, origin, key]);
  return {
    icon,
    unusable: () => {
      if (origin) setLinkFavicon(key, null);
    },
  };
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}
