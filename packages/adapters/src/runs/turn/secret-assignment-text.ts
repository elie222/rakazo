import { sanitizeSensitiveText } from "../../runtime/pi/pi-runtime-errors.js";

const COMPOSIO_API_KEY_LABEL = "composio_api_key";
const REDACTED_ASSIGNMENT = "COMPOSIO_API_KEY=[redacted]";
const REDACTED_VALUE = "[redacted]";

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function startsWithIgnoreCase(text: string, needle: string, index: number): boolean {
  if (index + needle.length > text.length) return false;
  for (let offset = 0; offset < needle.length; offset += 1) {
    let code = text.charCodeAt(index + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== needle.charCodeAt(offset)) return false;
  }
  return true;
}

/**
 * End of a quoted span that opens at `open`, or the newline / end that leaves it unclosed.
 * An unclosed span sets `barrier` so a later quote on the same line is not scanned again.
 */
function scanQuoted(text: string, open: number): { end: number; closed: boolean; barrier: number } {
  const quote = text[open];
  let index = open + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\\") {
      const next = index + 1;
      if (next >= text.length || text[next] === "\n" || text[next] === "\r") {
        return { end: index, closed: false, barrier: Math.min(next, text.length) };
      }
      index += 2;
      continue;
    }
    if (ch === quote) return { end: index + 1, closed: true, barrier: index + 1 };
    if (ch === "\n" || ch === "\r") return { end: index, closed: false, barrier: index };
    index += 1;
  }
  return { end: text.length, closed: false, barrier: text.length };
}

function isComposioLabel(text: string, start: number, end: number): boolean {
  return (
    end - start === COMPOSIO_API_KEY_LABEL.length &&
    startsWithIgnoreCase(text, COMPOSIO_API_KEY_LABEL, start)
  );
}

/** A `"` preceded by an odd number of backslashes is an escape, not the start of a string. */
function quoteIsEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let prev = index - 1; prev >= 0 && text[prev] === "\\"; prev -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Raw or JSON-decoded text of a closed string. `\u0043OMPOSIO_API_KEY` is `COMPOSIO_API_KEY`. */
function closedStringIsComposioKey(text: string, open: number, end: number): boolean {
  if (isComposioLabel(text, open + 1, end - 1)) return true;
  const raw = text.slice(open, end);
  if (!raw.includes("\\")) return false;
  try {
    const decoded: unknown = JSON.parse(raw);
    return typeof decoded === "string" && isComposioLabel(decoded, 0, decoded.length);
  } catch {
    return false;
  }
}

/** A quoted value after a COMPOSIO_API_KEY key, redacted inside its own quotes. */
function quotedKeyValue(
  text: string,
  from: number,
): { interiorStart: number; interiorEnd: number; resume: number } | undefined {
  let pos = from;
  while (isWhitespace(text[pos])) pos += 1;
  if (text[pos] !== "=" && text[pos] !== ":") return undefined;
  pos += 1;
  while (isWhitespace(text[pos])) pos += 1;
  const quote = text[pos];
  if (quote !== '"' && quote !== "'") return undefined;
  const scanned = scanQuoted(text, pos);
  if (scanned.closed) {
    return { interiorStart: pos + 1, interiorEnd: scanned.end - 1, resume: scanned.end };
  }
  let end = pos + 1;
  while (end < text.length && !isWhitespace(text[end])) end += 1;
  return { interiorStart: pos + 1, interiorEnd: end, resume: end };
}

/** End of an assignment value, or -1 when the separator has nothing after it. */
function assignmentValueEnd(text: string, open: number): number {
  const quote = text[open];
  if (quote === '"' || quote === "'") {
    let index = open + 1;
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === "\\") {
        const next = index + 1;
        if (next >= text.length || text[next] === "\n" || text[next] === "\r") break;
        index += 2;
        continue;
      }
      if (ch === quote) return index + 1;
      if (ch === "\n" || ch === "\r") break;
      index += 1;
    }
    let end = open;
    while (end < text.length && !isWhitespace(text[end])) end += 1;
    return end > open ? end : -1;
  }
  let end = open;
  while (end < text.length && !isWhitespace(text[end])) end += 1;
  return end > open ? end : -1;
}

/**
 * Redact a COMPOSIO_API_KEY assignment.
 * A closed JSON string is left intact unless its decoded text is the key itself, in which case
 * only the following quoted value is replaced. An escaped quote is not a string start. The
 * decoded string is redacted again by the JSON walker.
 * Whitespace may surround `:` or `=`, including a newline before a quoted value.
 */
export function redactComposioApiKeyAssignments(text: string): string {
  let out = "";
  let cursor = 0;
  let index = 0;
  let blockStringProbe = 0;
  while (index < text.length) {
    if (text[index] === '"' && index >= blockStringProbe && !quoteIsEscaped(text, index)) {
      const scanned = scanQuoted(text, index);
      if (scanned.closed) {
        if (closedStringIsComposioKey(text, index, scanned.end)) {
          const value = quotedKeyValue(text, scanned.end);
          if (value) {
            out += `${text.slice(cursor, value.interiorStart)}${REDACTED_VALUE}`;
            cursor = value.interiorEnd;
            index = value.resume;
            continue;
          }
        }
        index = scanned.end;
        continue;
      }
      blockStringProbe = scanned.barrier;
      index += 1;
      continue;
    }
    const code = text.charCodeAt(index);
    if (code !== 67 && code !== 99) {
      index += 1;
      continue;
    }
    if (!startsWithIgnoreCase(text, COMPOSIO_API_KEY_LABEL, index)) {
      index += 1;
      continue;
    }
    const before = index > 0 ? text.charCodeAt(index - 1) : 0;
    if (isIdentifierCode(before)) {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    let pos = index + COMPOSIO_API_KEY_LABEL.length;
    while (isWhitespace(text[pos])) pos += 1;
    if (text[pos] !== "=" && text[pos] !== ":") {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    pos += 1;
    while (isWhitespace(text[pos])) pos += 1;
    const end = assignmentValueEnd(text, pos);
    if (end < 0) {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    out += `${text.slice(cursor, index)}${REDACTED_ASSIGNMENT}`;
    cursor = end;
    index = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/** Assignment scan, then the shared text sanitizer. Used on decoded JSON strings and plain gaps. */
export function redactDecodedToolText(value: string): string {
  return sanitizeSensitiveText(redactComposioApiKeyAssignments(value));
}
