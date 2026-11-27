const COMPOSIO_API_KEY_LABEL = "composio_api_key";
const REDACTED_ASSIGNMENT = "COMPOSIO_API_KEY=[redacted]";

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

/** A complete JSON value. Pattern replacement must not reopen its quotes. */
function isJsonDocument(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * Redact a COMPOSIO_API_KEY assignment in text that is not a JSON document.
 * A JSON document is left unchanged so a value inside a string, and the fields beside it, stay valid.
 * Whitespace may surround `:` or `=`, including a newline before a quoted value.
 */
export function redactComposioApiKeyAssignments(text: string): string {
  if (isJsonDocument(text)) return text;
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
