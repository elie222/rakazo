import { createSecretMatcher } from "./secret-matcher.js";

const BOUNDED_OMISSION_MARKER = /(\n… \[\d+ characters not kept\] …\n)/;
const JSON_VALUE_TOKEN =
  /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const JSON_STRING_LITERAL_TOKEN = /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))/g;

function isJsonOutsidePrefix(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || "{}[],:".includes(ch)) {
      index += 1;
      continue;
    }
    if (text.startsWith("true", index) || text.startsWith("null", index)) {
      index += 4;
      continue;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let next = index + (ch === "-" ? 1 : 0);
      if (next >= text.length || text[next]! < "0" || text[next]! > "9") return false;
      while (next < text.length && text[next]! >= "0" && text[next]! <= "9") next += 1;
      if (text[next] === ".") {
        next += 1;
        if (next >= text.length || text[next]! < "0" || text[next]! > "9") return false;
        while (next < text.length && text[next]! >= "0" && text[next]! <= "9") next += 1;
      }
      if (text[next] === "e" || text[next] === "E") {
        next += 1;
        if (text[next] === "+" || text[next] === "-") next += 1;
        if (next >= text.length || text[next]! < "0" || text[next]! > "9") return false;
        while (next < text.length && text[next]! >= "0" && text[next]! <= "9") next += 1;
      }
      index = next;
      continue;
    }
    return false;
  }
  return true;
}

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function splitTrailingIncompleteJsonEscape(value: string): { trimmed: string; trailing: string } {
  const unicodeTail = /u[0-9a-fA-F]{0,3}$/.exec(value);
  const checkEnd = unicodeTail ? unicodeTail.index : value.length;
  let slashes = 0;
  for (let index = checkEnd - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  if (slashes % 2 === 1) {
    const cut = checkEnd - 1;
    return { trimmed: value.slice(0, cut), trailing: value.slice(cut) };
  }
  return { trimmed: value, trailing: "" };
}

function redactSingleJsonStringToken(
  token: string,
  redact: (text: string) => string,
  fallbackPlain?: (text: string) => string,
  checkRawOuterQuotes = false,
): string {
  try {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== "string") return fallbackPlain ? fallbackPlain(token) : token;
    const next = redact(decoded);
    if (next !== decoded) return JSON.stringify(next);
    if (checkRawOuterQuotes) {
      // An exact secret registered with surrounding quotes (e.g. `"opaque-123"`) will not match
      // the unquoted decoded text; accept raw-token redaction only when it altered an outer quote
      // so backslash-ending secrets cannot corrupt internal escapes such as `\"`.
      const rawRedacted = redact(token);
      if (rawRedacted !== token && (!rawRedacted.startsWith('"') || !rawRedacted.endsWith('"'))) {
        return JSON.stringify(rawRedacted);
      }
    }
    return token;
  } catch {
    // Truncated trailing string literal in cut-off JSON (including a lone trailing backslash).
    const { trimmed, trailing: trailingEscape } = splitTrailingIncompleteJsonEscape(token);
    try {
      const decoded: unknown = JSON.parse(`${trimmed}"`);
      if (typeof decoded !== "string") return fallbackPlain ? fallbackPlain(token) : token;
      const next = redact(decoded);
      return next === decoded ? token : `${JSON.stringify(next).slice(0, -1)}${trailingEscape}`;
    } catch {
      if (!fallbackPlain) return token;
      if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        return `"${fallbackPlain(token.slice(1, -1))}"`;
      }
      return fallbackPlain(token);
    }
  }
}

function redactJsonValueToken(
  token: string,
  offset: number,
  source: string,
  redact: (text: string) => string,
): string {
  if (token.startsWith('"')) return redactSingleJsonStringToken(token, redact);
  let prev = offset - 1;
  while (prev >= 0 && isJsonWhitespace(source[prev])) prev -= 1;
  const prevChar = prev >= 0 ? source[prev] : undefined;
  if (prevChar !== ":" && prevChar !== "," && prevChar !== "[") return token;
  let nextIndex = offset + token.length;
  while (nextIndex < source.length && isJsonWhitespace(source[nextIndex])) nextIndex += 1;
  const nextChar = nextIndex < source.length ? source[nextIndex] : undefined;
  if (nextChar !== undefined && nextChar !== "," && nextChar !== "}" && nextChar !== "]") {
    return token;
  }
  const next = redact(token);
  return next === token ? token : JSON.stringify(next);
}

function redactJsonTailPrefix(prefix: string, redact: (text: string) => string): string {
  const { trimmed, trailing: trailingEscape } = splitTrailingIncompleteJsonEscape(prefix);
  const tryDecode = (lead: string, body: string): string | undefined => {
    try {
      const decoded: unknown = JSON.parse(`"${body}"`);
      if (typeof decoded !== "string") return undefined;
      const next = redact(decoded);
      return next === decoded
        ? prefix
        : `${lead}${JSON.stringify(next).slice(1, -1)}${trailingEscape}`;
    } catch {
      return undefined;
    }
  };
  const direct = tryDecode("", trimmed);
  if (direct !== undefined) return direct;
  // Cutting through an escaped backslash (`\\`) can leave an orphaned leading `\` before a
  // non-escape character; recover past that single backslash and decode the rest of the tail.
  if (trimmed.startsWith("\\")) {
    const recovered = tryDecode("\\", trimmed.slice(1));
    if (recovered !== undefined) return recovered;
  }
  return redact(prefix);
}

function findUnescapedQuotes(line: string): number[] {
  const quotes: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }
    if (line[index] === '"') quotes.push(index);
  }
  return quotes;
}

function isPrecededByBearer(raw: string, index: number): boolean {
  let end = index - 1;
  while (end >= 0 && isJsonWhitespace(raw[end])) end -= 1;
  if (end < 5) return false;
  const start = end - 5;
  if (raw.slice(start, end + 1).toLowerCase() !== "bearer") return false;
  if (start === 0) return true;
  return !/[A-Za-z0-9_]/.test(raw[start - 1]!);
}

function precedesJsonStringToken(raw: string, index: number): boolean {
  let prev = index - 1;
  while (prev >= 0 && (raw[prev] === " " || raw[prev] === "\t")) prev -= 1;
  if (prev < 0) return true;
  const ch = raw[prev];
  // Line breaks delimit JSON Lines records, except after `Bearer` where a wrapped header
  // (`Authorization: Bearer\n "token"`) must stay together for plain-text Bearer matching.
  if (ch === "\n" || ch === "\r") return !isPrecededByBearer(raw, index);
  return ch === "{" || ch === "[" || ch === "," || ch === ":";
}

function isStrictJsonColon(raw: string, index: number, leadingQuote = false): boolean {
  let prev = index - 1;
  while (prev >= 0 && (raw[prev] === " " || raw[prev] === "\t")) prev -= 1;
  if (prev < 0 || raw[prev] !== ":") return true;
  prev -= 1;
  while (prev >= 0 && isJsonWhitespace(raw[prev])) prev -= 1;
  return prev < 0 ? leadingQuote : raw[prev] === '"';
}

function isJsonValueSlot(raw: string, start: number, end: number): boolean {
  let prev = start - 1;
  while (prev >= 0 && isJsonWhitespace(raw[prev])) prev -= 1;
  if (prev < 0) return false;
  const prevChar = raw[prev];
  if (prevChar === ":") {
    prev -= 1;
    while (prev >= 0 && isJsonWhitespace(raw[prev])) prev -= 1;
    if (prev < 0 || raw[prev] !== '"') return false;
  } else if (prevChar !== "[" && prevChar !== ",") {
    return false;
  }
  let next = end;
  while (next < raw.length && isJsonWhitespace(raw[next])) next += 1;
  if (next >= raw.length) return true;
  const nextChar = raw[next];
  return nextChar === "," || nextChar === "}" || nextChar === "]";
}

function isClosedJsonStringToken(token: string): boolean {
  if (token.length < 2 || !token.endsWith('"')) return false;
  let slashes = 0;
  for (let index = token.length - 2; index >= 0 && token[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 0;
}

function followsJsonStringToken(raw: string, end: number, closed: boolean): boolean {
  if (!closed) return true;
  let next = end;
  while (next < raw.length && (raw[next] === " " || raw[next] === "\t")) next += 1;
  if (next >= raw.length || raw[next] === "\n" || raw[next] === "\r") return true;
  const ch = raw[next];
  return ch === ":" || ch === "," || ch === "}" || ch === "]";
}

function overlapsSortedRange(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [rStart, rEnd] = ranges[mid]!;
    if (rEnd <= start) lo = mid + 1;
    else if (rStart >= end) hi = mid - 1;
    else return true;
  }
  return false;
}

function replaceJsonSegmentTokens(
  chunk: string,
  redact: (text: string) => string,
  leadingQuote = false,
): string {
  let out = "";
  let cursor = 0;
  for (const match of chunk.matchAll(JSON_VALUE_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    const end = index + token.length;
    if (token.startsWith('"')) {
      if (
        !precedesJsonStringToken(chunk, index) ||
        !followsJsonStringToken(chunk, end, isClosedJsonStringToken(token))
      ) {
        continue;
      }
      const replaced = redactSingleJsonStringToken(token, redact, redact, true);
      // Keep an unchanged string after an unquoted diagnostic label (`fixture: "opaque-123"`) in
      // the surrounding plain-text span so cross-colon exact secrets still match whole.
      if (replaced === token && !isStrictJsonColon(chunk, index, leadingQuote)) {
        continue;
      }
      if (index > cursor) out += redact(chunk.slice(cursor, index));
      out += replaced;
      cursor = end;
      continue;
    }
    const replaced = redactJsonValueToken(token, index, chunk, redact);
    if (replaced !== token) {
      if (index > cursor) out += redact(chunk.slice(cursor, index));
      out += replaced;
      cursor = end;
    }
  }
  if (cursor < chunk.length) out += redact(chunk.slice(cursor));
  return out;
}

function redactJsonSegment(
  segment: string,
  afterOmission: boolean,
  redact: (text: string) => string,
): string {
  const replaceTokens = (chunk: string, leadingQuote = false) =>
    replaceJsonSegmentTokens(chunk, redact, leadingQuote);
  if (afterOmission) {
    const lineBreak = segment.search(/[\r\n]/);
    const firstLine = lineBreak >= 0 ? segment.slice(0, lineBreak) : segment;
    const restLines = lineBreak >= 0 ? segment.slice(lineBreak) : "";
    const firstQuotes = findUnescapedQuotes(firstLine);
    // Cutting between the two backslashes of a trailing `\\"` leaves `\"` right before a delimiter.
    if (/^\\"\s*(?:[,}\]:]|$)/.test(firstLine) && firstQuotes.length % 2 === 0) {
      return `\\"${replaceTokens(segment.slice(2), true)}`;
    }
    if (firstQuotes.length > 0) {
      const firstQuote = firstQuotes[0]!;
      const beforeFirst = firstLine.slice(0, firstQuote);
      const afterFirst = segment.slice(firstQuote);
      const outsideOnly = isJsonOutsidePrefix(beforeFirst);
      const startsInsideString =
        (beforeFirst.trim().length > 0 && (!outsideOnly || !/[{[:,]\s*$/.test(beforeFirst))) ||
        (firstQuotes.length % 2 === 1 && /^"\s*(?:[,}\]:]|$)/.test(afterFirst));
      if (startsInsideString) {
        return (
          redactJsonTailPrefix(beforeFirst, redact) +
          '"' +
          replaceTokens(segment.slice(firstQuote + 1), true)
        );
      }
    } else if (firstLine.includes("\\")) {
      return redactJsonTailPrefix(firstLine, redact) + replaceTokens(restLines);
    }
  }
  return replaceTokens(segment);
}

function redactJsonStringTokens(raw: string, redact: (text: string) => string): string {
  const parts = raw.split(BOUNDED_OMISSION_MARKER);
  if (parts.length === 1) return redactJsonSegment(raw, false, redact);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : redactJsonSegment(part, index > 0, redact)))
    .join("");
}

function redactJsonStringsSlice(
  raw: string,
  sliceStart: number,
  sliceEnd: number,
  redactString: (text: string) => string,
  redactPlain: (text: string) => string,
  quoteMatches: ReadonlyArray<readonly [number, number]>,
): string {
  const chunk = raw.slice(sliceStart, sliceEnd);
  if (!chunk.includes('"')) return redactPlain(chunk);
  let out = "";
  let cursor = 0;
  for (const match of chunk.matchAll(JSON_STRING_LITERAL_TOKEN)) {
    const localIndex = match.index ?? 0;
    const token = match[0];
    const localEnd = localIndex + token.length;
    const absIndex = sliceStart + localIndex;
    const absEnd = sliceStart + localEnd;
    const closed = isClosedJsonStringToken(token);
    // Plain diagnostics such as `Bearer "secret"`, `Bearer\n "secret"`, or `Error: "a"b"` do not
    // sit between JSON structural delimiters, and a registered secret crossing a quote must stay
    // intact in `redactPlain`.
    if (
      !precedesJsonStringToken(raw, absIndex) ||
      !followsJsonStringToken(raw, absEnd, closed) ||
      (quoteMatches.length > 0 &&
        (overlapsSortedRange(quoteMatches, absIndex, absIndex + 1) ||
          (closed && overlapsSortedRange(quoteMatches, absEnd - 1, absEnd))))
    ) {
      continue;
    }
    if (localIndex > cursor) out += redactPlain(chunk.slice(cursor, localIndex));
    out += redactSingleJsonStringToken(token, redactString, redactPlain);
    cursor = localEnd;
  }
  if (cursor < chunk.length) out += redactPlain(chunk.slice(cursor));
  return out;
}

/**
 * Redact JSON string tokens after decoding them and apply `redactPlain` only to non-string text
 * between tokens, so pattern redactors never consume JSON quotes, escapes, or sibling fields.
 */
export function redactJsonStringsAndPlainText(
  raw: string,
  redactString: (text: string) => string,
  redactPlain: (text: string) => string = redactString,
  wholeSecrets?: readonly string[],
): string {
  if (!raw.includes('"')) return redactPlain(raw);
  const quoteSecrets = wholeSecrets?.filter((value) => value.includes('"')) ?? [];
  const quoteMatches = quoteSecrets.length > 0 ? createSecretMatcher(quoteSecrets).ranges(raw) : [];
  const valueSlotMatches = quoteMatches.filter(([start, end]) => isJsonValueSlot(raw, start, end));
  if (valueSlotMatches.length === 0) {
    return redactJsonStringsSlice(raw, 0, raw.length, redactString, redactPlain, quoteMatches);
  }
  let out = "";
  let cursor = 0;
  for (const [slotStart, slotEnd] of valueSlotMatches) {
    if (slotStart > cursor) {
      out += redactJsonStringsSlice(
        raw,
        cursor,
        slotStart,
        redactString,
        redactPlain,
        quoteMatches,
      );
    }
    // Replacing an entire JSON value secret (e.g. `{"mode":"opaque-123"}`) with a JSON string
    // preserves surrounding valid JSON structure.
    out += '"[redacted]"';
    cursor = slotEnd;
  }
  if (cursor < raw.length) {
    out += redactJsonStringsSlice(raw, cursor, raw.length, redactString, redactPlain, quoteMatches);
  }
  return out;
}

export function redactJsonText(raw: string, redact: (text: string) => string): string {
  return redactJsonStringTokens(raw, redact);
}
