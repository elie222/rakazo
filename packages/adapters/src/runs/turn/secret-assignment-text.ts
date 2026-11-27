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

/** True when `pos` opens `Bearer <non-whitespace>`, so the Bearer pass should redact the token. */
function startsWithBearerToken(text: string, pos: number): boolean {
  if (!startsWithIgnoreCase(text, "bearer", pos)) return false;
  let next = pos + 6;
  if (!isWhitespace(text[next])) return false;
  while (next < text.length && isWhitespace(text[next])) next += 1;
  return next < text.length;
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
  if (startsWithBearerToken(text, pos + 1)) return undefined;
  let end = pos + 1;
  while (end < text.length && !isWhitespace(text[end])) end += 1;
  return { interiorStart: pos + 1, interiorEnd: end, resume: end };
}

/** True when `open` is a quoted COMPOSIO_API_KEY key followed by a quoted value. */
function quotedComposioKeyAt(text: string, open: number): boolean {
  if (text[open] !== '"' || quoteIsEscaped(text, open)) return false;
  const scanned = scanQuoted(text, open);
  if (!scanned.closed || !closedStringIsComposioKey(text, open, scanned.end)) return false;
  return quotedKeyValue(text, scanned.end) !== undefined;
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
    if (startsWithBearerToken(text, open + 1)) return -1;
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
 * only the following quoted value is replaced. An escaped quote is not a string start. A closer
 * is tried again as an opener only when that quote starts a COMPOSIO_API_KEY field. Any other
 * closer stays closed, so a log prefix cannot hide a later bare assignment. The decoded string
 * is redacted again by the JSON walker. Whitespace may surround `:` or `=`, including a newline
 * before a quoted value.
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
          index = scanned.end;
          continue;
        }
        // `mix"ed' {"COMPOSIO_API_KEY"` closes on the real key. Any other closer must not be
        // retried: `msg="ready"` would swallow the next bare `COMPOSIO_API_KEY:` assignment.
        index = quotedComposioKeyAt(text, scanned.end - 1) ? scanned.end - 1 : scanned.end;
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
    if (startsWithBearerToken(text, pos)) {
      index = pos;
      continue;
    }
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

/** Same note a truncated tool result writes. A longer digit run is not this marker. */
const CREDENTIAL_OMISSION_PREFIX = "\n… [";
const CREDENTIAL_OMISSION_SUFFIX = " characters not kept] …\n";
const CREDENTIAL_OMISSION_MAX_DIGITS = 16;

function omissionMarkerEnd(text: string, index: number): number {
  if (!text.startsWith(CREDENTIAL_OMISSION_PREFIX, index)) return -1;
  let pos = index + CREDENTIAL_OMISSION_PREFIX.length;
  const digitStart = pos;
  const digitLimit = Math.min(text.length, pos + CREDENTIAL_OMISSION_MAX_DIGITS);
  while (pos < digitLimit) {
    const code = text.charCodeAt(pos);
    if (code < 48 || code > 57) break;
    pos += 1;
  }
  if (pos === digitStart || !text.startsWith(CREDENTIAL_OMISSION_SUFFIX, pos)) return -1;
  return pos + CREDENTIAL_OMISSION_SUFFIX.length;
}

/** Keyword match on a JSON object key after its escapes are decoded. */
const CREDENTIAL_KEY_NAME =
  /(?:api[_-]?key|token|password|passwd|secret|authorization|credential)/i;

/**
 * True when `lineStart` opens a new JSON property line (e.g. `  "token":` or `}, "token":`).
 * Inspects only the current line, so calling it once per physical newline keeps scanning linear.
 */
function isJsonPropertyLineStart(text: string, lineStart: number): boolean {
  let pos = lineStart;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === " " || ch === "\t" || ch === "}" || ch === "]" || ch === "," || ch === "{") {
      pos += 1;
      continue;
    }
    break;
  }
  if (pos >= text.length || text[pos] !== '"') return false;
  let keyEnd = pos + 1;
  while (keyEnd < text.length) {
    const ch = text[keyEnd]!;
    if (ch === '"') break;
    if (ch === "\n" || ch === "\r") return false;
    if (ch === "\\") {
      if (keyEnd + 1 >= text.length || text[keyEnd + 1] === "\n" || text[keyEnd + 1] === "\r") {
        return false;
      }
      keyEnd += 2;
      continue;
    }
    keyEnd += 1;
  }
  if (keyEnd >= text.length || text[keyEnd] !== '"') return false;
  let colonPos = keyEnd + 1;
  while (
    colonPos < text.length &&
    (text[colonPos] === " " ||
      text[colonPos] === "\t" ||
      text[colonPos] === "\r" ||
      text[colonPos] === "\n")
  ) {
    colonPos += 1;
  }
  return colonPos < text.length && text[colonPos] === ":";
}

type JsonStringEnd = {
  end: number;
  fragmentEnd: number;
  nextIndex: number;
  /** True when [fragmentEnd, nextIndex) is an omission marker kept out of the value. */
  omission: boolean;
};

/**
 * Index of the `\n` that may open an omission marker at this break. A `\r\n` break checks the
 * marker at the line feed.
 */
function omissionMarkerBreak(text: string, index: number): number {
  if (text[index] === "\n") return index;
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 1;
  return -1;
}

function markerBoundary(text: string, index: number): JsonStringEnd | undefined {
  const markerAt = omissionMarkerBreak(text, index);
  if (markerAt < 0) return undefined;
  const markerEnd = omissionMarkerEnd(text, markerAt);
  if (markerEnd < 0) return undefined;
  return { end: -1, fragmentEnd: markerAt, nextIndex: markerEnd, omission: true };
}

function scanJsonStringEnd(
  text: string,
  openQuote: number,
  honorOmissionMarker: boolean,
): JsonStringEnd {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "\n" || ch === "\r") {
      if (honorOmissionMarker) {
        const marker = markerBoundary(text, index);
        if (marker) return marker;
      }
      const nextLineStart = ch === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
      if (isJsonPropertyLineStart(text, nextLineStart)) {
        return { end: -1, fragmentEnd: index, nextIndex: nextLineStart, omission: false };
      }
      if (nextLineStart > index + 1) index += 1;
      continue;
    }
    if (ch === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        return { end: -1, fragmentEnd: text.length, nextIndex: text.length, omission: false };
      }
      if (next === "\n" || next === "\r") {
        if (honorOmissionMarker) {
          const marker = markerBoundary(text, index + 1);
          if (marker) return marker;
        }
        const nextLineStart = next === "\r" && text[index + 2] === "\n" ? index + 3 : index + 2;
        if (isJsonPropertyLineStart(text, nextLineStart)) {
          return { end: -1, fragmentEnd: index + 1, nextIndex: nextLineStart, omission: false };
        }
        index = nextLineStart - 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      return { end: index, fragmentEnd: index + 1, nextIndex: index + 1, omission: false };
    }
  }
  return { end: -1, fragmentEnd: text.length, nextIndex: text.length, omission: false };
}

const REDACTED_PLACEHOLDER = "[redacted]";

function skipJsonSpace(text: string, index: number): number {
  while (index < text.length) {
    const ch = text[index]!;
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
    index += 1;
  }
  return index;
}

/** Length of one JSON string escape at the backslash, or 0 when the escape is incomplete. */
function jsonEscapeLength(text: string, index: number): number {
  const next = text[index + 1];
  if (
    next === '"' ||
    next === "\\" ||
    next === "/" ||
    next === "b" ||
    next === "f" ||
    next === "n" ||
    next === "r" ||
    next === "t"
  ) {
    return 2;
  }
  if (next !== "u") return 0;
  for (let hex = 0; hex < 4; hex += 1) {
    const code = text.charCodeAt(index + 2 + hex);
    const digit =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (!digit) return 0;
  }
  return 6;
}

type JsonKeyString =
  | { kind: "closed"; end: number }
  | { kind: "bad-escape"; resume: number }
  | { kind: "open"; resume: number };

/** Index just after a raw `\n`, `\r`, or `\r\n` at `index`, or `text.length` at the end. */
function lineBreakResume(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 2;
  return index + 1;
}

/**
 * A closed JSON string, an invalid escape to resume after, or no closer before a line break.
 * An invalid escape such as `\l` resumes after the backslash. A raw `\n`, `\r`, or `\r\n`
 * resumes after that break, so a later credential on the same record is still seen.
 */
function scanJsonKeyString(text: string, index: number): JsonKeyString {
  if (text[index] !== '"') return { kind: "open", resume: Math.min(index + 1, text.length) };
  let end = index + 1;
  while (end < text.length) {
    const ch = text[end]!;
    if (ch === "\n" || ch === "\r") return { kind: "open", resume: lineBreakResume(text, end) };
    if (ch === "\\") {
      const size = jsonEscapeLength(text, end);
      if (size === 0) return { kind: "bad-escape", resume: end + 1 };
      end += size;
      continue;
    }
    if (ch === '"') return { kind: "closed", end: end + 1 };
    end += 1;
  }
  return { kind: "open", resume: text.length };
}

/** Index just after the JSON string that opens at `index`, or -1. A raw newline ends it. */
function jsonStringEnd(text: string, index: number): number {
  const scanned = scanJsonKeyString(text, index);
  return scanned.kind === "closed" ? scanned.end : -1;
}

/** True when `index` is the opening quote of a JSON key followed by `:`. */
function keyColonAt(text: string, index: number): boolean {
  const afterKey = jsonStringEnd(text, index);
  if (afterKey < 0) return false;
  return text[skipJsonSpace(text, afterKey)] === ":";
}

/** Whitespace, a comma, or a container close. A `:` is not a value delimiter. */
function jsonDelimiter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index]!;
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "," ||
    ch === "}" ||
    ch === "]"
  );
}

/**
 * Index just after a JSON number at `index`, or -1. A bare `-`, a leading zero, a trailing dot,
 * or an exponent with no digits is not a number. The scan never steps backward.
 */
function jsonNumberEnd(text: string, index: number): number {
  let pos = index;
  if (text[pos] === "-") pos += 1;
  const first = text[pos];
  if (first === "0") {
    pos += 1;
  } else if (first !== undefined && first >= "1" && first <= "9") {
    pos += 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  } else {
    return -1;
  }
  if (text[pos] === ".") {
    const frac = pos + 1;
    if (frac >= text.length || text[frac]! < "0" || text[frac]! > "9") return -1;
    pos = frac + 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  }
  if (text[pos] === "e" || text[pos] === "E") {
    let exp = pos + 1;
    if (text[exp] === "+" || text[exp] === "-") exp += 1;
    if (exp >= text.length || text[exp]! < "0" || text[exp]! > "9") return -1;
    pos = exp + 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  }
  return pos;
}

function jsonValueStarts(text: string, index: number): boolean {
  const at = skipJsonSpace(text, index);
  if (at >= text.length) return false;
  const ch = text[at]!;
  if (ch === '"' || ch === "{" || ch === "[") return true;
  if (text.startsWith("true", at) && jsonDelimiter(text, at + 4)) return true;
  if (text.startsWith("false", at) && jsonDelimiter(text, at + 5)) return true;
  if (text.startsWith("null", at) && jsonDelimiter(text, at + 4)) return true;
  const end = jsonNumberEnd(text, at);
  return end > at && jsonDelimiter(text, end);
}

/**
 * A `"` ends a credential when the containers close or another field starts after it.
 * `}` and `]` may nest (`}]`), with space between them. A comma counts only with a quoted key,
 * a colon, and a real JSON value, or with another closer. A bare `]` with no quote does not.
 */
function authenticAfterQuote(text: string, quote: number): boolean {
  let index = skipJsonSpace(text, quote + 1);
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "}" || ch === "]") {
      index = skipJsonSpace(text, index + 1);
      if (index >= text.length) return true;
      continue;
    }
    if (ch !== ",") return false;
    const at = skipJsonSpace(text, index + 1);
    if (at >= text.length) return false;
    if (text[at] === "}" || text[at] === "]") {
      index = at;
      continue;
    }
    if (!keyColonAt(text, at)) return false;
    const keyEnd = jsonStringEnd(text, at);
    const colon = skipJsonSpace(text, keyEnd);
    return text[colon] === ":" && jsonValueStarts(text, colon + 1);
  }
  return true;
}

/** Value text between the opening quote and the marker, ignoring one trailing carriage return. */
function credentialHeadValue(text: string, openQuote: number, markerAt: number): string {
  let end = markerAt;
  if (text[end - 1] === "\r" && end - 1 > openQuote) end -= 1;
  return text.slice(openQuote + 1, end);
}

/**
 * Index of the closing quote when the head and tail are the two halves of `[redacted]"`, or -1.
 * Rewriting that placeholder would grow the saved text.
 */
function redactedSplitQuote(headValue: string, tail: string): number {
  if (headValue.length === 0 || !REDACTED_PLACEHOLDER.startsWith(headValue)) return -1;
  const rest = REDACTED_PLACEHOLDER.slice(headValue.length);
  if (!tail.startsWith(rest) || tail[rest.length] !== '"') return -1;
  return authenticAfterQuote(tail, rest.length) ? rest.length : -1;
}

/**
 * Index of a quote that really ends the credential. A `"` whose escaping backslash was cut off
 * is followed by more of the value, so it does not count.
 */
function confirmedCredentialClose(tail: string): number {
  for (let index = 0; index < tail.length; index += 1) {
    const ch = tail[index]!;
    if (ch === "\\") {
      if (index + 1 >= tail.length) return -1;
      index += 1;
      continue;
    }
    if (ch === '"' && authenticAfterQuote(tail, index)) return index;
  }
  return -1;
}

/**
 * The credential closed inside the omitted span. The tail is the next JSON field, a brace, or a
 * short non-secret lead into that field. It is not the rest of the credential.
 */
function structuralLeadEnd(tail: string): number {
  let index = 0;
  while (index < tail.length) {
    const lead = tail[index]!;
    if (
      lead !== " " &&
      lead !== "\t" &&
      lead !== "\n" &&
      lead !== "\r" &&
      lead !== "…" &&
      lead !== "."
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

/**
 * True when `index` opens `]` / `}` closers and the next thing is a comma plus a real JSON field.
 * A bare `]` or a `]` with raw text after it is still the credential.
 */
function closersThenField(text: string, index: number): boolean {
  let at = index;
  if (text[at] !== "]" && text[at] !== "}") return false;
  while (at < text.length && (text[at] === "]" || text[at] === "}")) {
    at = skipJsonSpace(text, at + 1);
  }
  if (at >= text.length || text[at] !== ",") return false;
  const key = skipJsonSpace(text, at + 1);
  if (!keyColonAt(text, key)) return false;
  const keyEnd = jsonStringEnd(text, key);
  const colon = skipJsonSpace(text, keyEnd);
  return text[colon] === ":" && jsonValueStarts(text, colon + 1);
}

/** True when `open` is a quoted credential key followed by `:` and a quoted value. */
function quotedCredentialKeyAt(text: string, open: number): boolean {
  if (text[open] !== '"' || quoteIsEscaped(text, open)) return false;
  const scanned = scanJsonKeyString(text, open);
  if (scanned.kind !== "closed") return false;
  const interior = text.slice(open + 1, scanned.end - 1);
  let keyName = interior;
  if (interior.includes("\\")) {
    try {
      const decoded: unknown = JSON.parse(text.slice(open, scanned.end));
      if (typeof decoded !== "string") return false;
      keyName = decoded;
    } catch {
      return false;
    }
  }
  if (!CREDENTIAL_KEY_NAME.test(keyName)) return false;
  let pos = scanned.end;
  while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
  if (text[pos] !== ":") return false;
  pos += 1;
  while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
  return text[pos] === '"';
}

function isStructuralContinuation(tail: string): boolean {
  const start = structuralLeadEnd(tail);
  if (start >= tail.length) return true;
  const ch = tail[start]!;
  if (ch === '"') {
    if (authenticAfterQuote(tail, start)) return true;
    if (!keyColonAt(tail, start)) return false;
    const keyEnd = jsonStringEnd(tail, start);
    const colon = skipJsonSpace(tail, keyEnd);
    return tail[colon] === ":" && jsonValueStarts(tail, colon + 1);
  }
  if (ch === "," || ch === "}") return authenticAfterQuote(tail, start - 1);
  if (ch === "]") return closersThenField(tail, start);
  return false;
}

/** Linear-time replacement for JSON fields whose key name indicates a credential string value. */
export function redactCredentialJsonFields(text: string, honorOmissionMarker: boolean): string {
  if (!text.includes('"')) return text;
  let cursor = 0;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const openKey = text.indexOf('"', index);
    if (openKey < 0) break;
    if (quoteIsEscaped(text, openKey)) {
      index = openKey + 1;
      continue;
    }
    const scannedKey = scanJsonKeyString(text, openKey);
    if (scannedKey.kind !== "closed") {
      index = scannedKey.resume;
      continue;
    }
    const closeKey = scannedKey.end;
    let keyName = "";
    try {
      const decoded: unknown = JSON.parse(text.slice(openKey, closeKey));
      if (typeof decoded === "string") keyName = decoded;
    } catch {
      keyName = "";
    }
    let pos = closeKey;
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
    // Retry the closer only when it opens a real key (`mix"ed' {"access_token"`).
    // Retrying every closer hides a later assignment inside a fake string.
    if (!CREDENTIAL_KEY_NAME.test(keyName) || text[pos] !== ":") {
      index = quotedCredentialKeyAt(text, closeKey - 1) ? closeKey - 1 : closeKey;
      continue;
    }
    pos += 1;
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
    if (text[pos] !== '"') {
      index = pos;
      continue;
    }
    const scanned = scanJsonStringEnd(text, pos, honorOmissionMarker);
    // A saved cut can split one credential around a real omission marker. Keep the marker.
    // An already-redacted placeholder stays as saved. A later JSON field stays too. An unclosed
    // legacy value is redacted through its end, including a quote whose escape was cut off.
    if (scanned.omission) {
      const headValue = credentialHeadValue(text, pos, scanned.fragmentEnd);
      const tail = text.slice(scanned.nextIndex);
      const splitQuote = redactedSplitQuote(headValue, tail);
      // `[r` + `edacted]"` is the saved placeholder, and nothing raw sits inside that value.
      if (splitQuote >= 0) {
        index = scanned.nextIndex + splitQuote + 1;
        continue;
      }
      const marker = text.slice(scanned.fragmentEnd, scanned.nextIndex);
      if (isStructuralContinuation(tail)) {
        out += `${text.slice(cursor, pos)}"[redacted]"${marker}`;
        cursor = scanned.nextIndex;
        index = scanned.nextIndex;
        continue;
      }
      const close = confirmedCredentialClose(tail);
      out += `${text.slice(cursor, pos)}"[redacted]"${marker}[redacted]`;
      cursor = close >= 0 ? scanned.nextIndex + close : text.length;
      index = cursor;
      continue;
    }
    out += `${text.slice(cursor, pos)}"[redacted]"`;
    cursor = scanned.fragmentEnd;
    index = scanned.nextIndex;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
