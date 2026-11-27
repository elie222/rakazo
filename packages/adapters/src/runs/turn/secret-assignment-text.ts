const COMPOSIO_API_KEY_LABEL = "composio_api_key";

function startsWithIgnoreCase(text: string, needle: string, index: number): boolean {
  if (index + needle.length > text.length) return false;
  for (let offset = 0; offset < needle.length; offset += 1) {
    let code = text.charCodeAt(index + offset);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== needle.charCodeAt(offset)) return false;
  }
  return true;
}

/** End of a quoted assignment value, or -1 when the quote never closes. */
function quotedAssignmentEnd(text: string, open: number): number {
  const quote = text[open]!;
  let index = open + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    if (quote === '"' && (ch === "\n" || ch === "\r")) return -1;
    index += 1;
  }
  return -1;
}

/**
 * Redact a COMPOSIO_API_KEY assignment before JSON-like quotes are split from the label.
 * Quoted values keep their quotes, so a real JSON field stays valid.
 */
export function redactComposioApiKeyAssignments(text: string): string {
  let out = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
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
    const identifier =
      (before >= 48 && before <= 57) ||
      (before >= 65 && before <= 90) ||
      (before >= 97 && before <= 122) ||
      before === 95;
    if (identifier) {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    let pos = index + COMPOSIO_API_KEY_LABEL.length;
    let sawSeparator = false;
    if (text[pos] === "=" || text[pos] === ":") {
      sawSeparator = true;
      pos += 1;
    }
    const afterSeparator = pos;
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos += 1;
    if (pos !== afterSeparator) sawSeparator = true;
    if (!sawSeparator) {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    const quote = text[pos];
    if (quote === '"' || quote === "'") {
      const end = quotedAssignmentEnd(text, pos);
      if (end < 0) {
        index += COMPOSIO_API_KEY_LABEL.length;
        continue;
      }
      out += `${text.slice(cursor, pos + 1)}[redacted]${quote}`;
      cursor = end;
      index = end;
      continue;
    }
    let end = pos;
    while (end < text.length) {
      const ch = text[end]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      end += 1;
    }
    if (end === pos) {
      index += COMPOSIO_API_KEY_LABEL.length;
      continue;
    }
    out += `${text.slice(cursor, pos)}[redacted]`;
    cursor = end;
    index = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
