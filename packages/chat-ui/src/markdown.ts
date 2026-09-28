export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
};

type LinkifyParser = {
  set(options: { linkify: boolean }): unknown;
  linkify: {
    set(options: { fuzzyLink: boolean }): unknown;
    add(schema: string, definition: null): unknown;
  };
};

/**
 * Turn bare http(s) URLs and email addresses into links, as the web renderer's GFM autolinks
 * do. Bare domains stay text: fuzzy matching would also link file names like setup.py or
 * notes.md. ftp: and protocol-relative URLs stay text because sanitizeMarkdownUrl would not
 * open them.
 */
export function linkifyExplicitUrls<T extends LinkifyParser>(parser: T): T {
  parser.set({ linkify: true });
  parser.linkify.set({ fuzzyLink: false });
  parser.linkify.add("ftp:", null);
  parser.linkify.add("//", null);
  return parser;
}

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

const TRAILING_LINK_PUNCTUATION = /[.,;:!?)]+$/u;
// Explicit addresses only. Bare domains and file names (setup.py, notes.md) stay
// text, matching linkifyExplicitUrls.
const PLAIN_TEXT_LINK =
  /https?:\/\/[^\s<>"')\]]+|mailto:[^\s<>"')\]]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/giu;

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
 * User bubbles stay plain text on web and mobile: bold, headings, and other
 * markdown remain characters. Only explicit http(s) URLs, mailto links, and
 * email addresses become links — the same autolinks bot messages already open —
 * so a sent address is tappable without the surfaces formatting differently.
 */
export function plainTextLinkParts(text: string): PlainTextPart[] {
  const parts: PlainTextPart[] = [];
  let cursor = 0;
  const pattern = new RegExp(PLAIN_TEXT_LINK.source, PLAIN_TEXT_LINK.flags);

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined || start < cursor) continue;
    const matched = match[0];
    const trailing = matched.match(TRAILING_LINK_PUNCTUATION)?.[0] ?? "";
    const value = matched.slice(0, matched.length - trailing.length);
    if (!value) continue;

    const href =
      value.includes("://") || value.toLowerCase().startsWith("mailto:")
        ? sanitizeMarkdownUrl(value)
        : sanitizeMarkdownUrl(`mailto:${value}`);
    appendPlainText(parts, text.slice(cursor, start));
    if (!href) {
      appendPlainText(parts, matched);
      cursor = start + matched.length;
      continue;
    }
    parts.push({ type: "link", value, href });
    cursor = start + value.length;
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
