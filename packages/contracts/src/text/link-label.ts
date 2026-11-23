/* Links show a short label on every client and the server matches quotes against it, so
   the rule lives here once. */

const SHORT_LINK_LABEL_MAX = 40;
const SHORT_LINK_PATH_MIN = 12;
// Control and format characters (bidi overrides, zero-width joiners and spaces, the BOM) that a
// decoded path could use to disguise itself.
const HIDDEN_PATH_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export function httpUrl(href: string): URL | undefined {
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
  if (path.length <= room) return `${host}${path}`;
  let end = room - 1;
  const before = path.charCodeAt(end - 1);
  const after = path.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return `${host}${path.slice(0, end)}…`;
}
