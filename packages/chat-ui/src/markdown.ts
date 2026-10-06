/// <reference path="./linkify-it.d.ts" />
import LinkifyIt from "linkify-it";

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
 * Markdown images in bot output never fetch: an image URL can carry conversation data to any
 * host the moment a reply renders, with no click. Only embedded raster data stays an image;
 * renderers show any other image as a link the reader can choose to open.
 */
export function inlineMarkdownImageSrc(url: string): string | undefined {
  const value = url.trim();
  return value.length <= MAX_INLINE_IMAGE_URL_LENGTH && inlineImagePattern.test(value)
    ? value
    : undefined;
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
