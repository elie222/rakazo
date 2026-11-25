import { createSecretMatcher } from "./secret-matcher.js";

const BOUNDED_OMISSION_MARKER = /(\n… \[\d+ characters not kept\] …\n)/;
const JSON_VALUE_TOKEN =
  /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const JSON_STRING_LITERAL_TOKEN = /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))/g;
const MAX_JSON_SPAN_DEPTH = 256;

type JsonStringNode = { kind: "string"; start: number; end: number };
type JsonNode =
  | JsonStringNode
  | { kind: "primitive"; start: number; end: number }
  | { kind: "array"; start: number; end: number; items: JsonNode[] }
  | {
      kind: "object";
      start: number;
      end: number;
      entries: Array<{ key: JsonStringNode; value: JsonNode }>;
    };

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function parseJsonSpans(raw: string): JsonNode | undefined {
  let pos = 0;
  const skipWs = () => {
    while (pos < raw.length && isJsonWhitespace(raw[pos])) pos += 1;
  };
  const parseString = (): JsonStringNode | undefined => {
    if (raw[pos] !== '"') return undefined;
    const start = pos;
    pos += 1;
    while (pos < raw.length) {
      const code = raw.charCodeAt(pos);
      if (code < 0x20) return undefined;
      if (code === 0x5c) {
        pos += 1;
        if (pos >= raw.length) return undefined;
        const esc = raw[pos]!;
        if (esc === "u") {
          for (let i = 1; i <= 4; i += 1) {
            if (pos + i >= raw.length || !/[0-9a-fA-F]/.test(raw[pos + i]!)) return undefined;
          }
          pos += 5;
        } else if ('"\\/bfnrt'.includes(esc)) {
          pos += 1;
        } else {
          return undefined;
        }
        continue;
      }
      if (code === 0x22) {
        pos += 1;
        return { kind: "string", start, end: pos };
      }
      pos += 1;
    }
    return undefined;
  };
  const parsePrimitive = (): (JsonNode & { kind: "primitive" }) | undefined => {
    const start = pos;
    if (raw.startsWith("true", pos) || raw.startsWith("null", pos)) {
      pos += 4;
      return { kind: "primitive", start, end: pos };
    }
    if (raw.startsWith("false", pos)) {
      pos += 5;
      return { kind: "primitive", start, end: pos };
    }
    if (raw[pos] === "-") pos += 1;
    if (pos >= raw.length) return undefined;
    if (raw[pos] === "0") {
      pos += 1;
    } else if (raw[pos]! >= "1" && raw[pos]! <= "9") {
      while (pos < raw.length && raw[pos]! >= "0" && raw[pos]! <= "9") pos += 1;
    } else {
      return undefined;
    }
    if (raw[pos] === ".") {
      pos += 1;
      if (pos >= raw.length || raw[pos]! < "0" || raw[pos]! > "9") return undefined;
      while (pos < raw.length && raw[pos]! >= "0" && raw[pos]! <= "9") pos += 1;
    }
    if (raw[pos] === "e" || raw[pos] === "E") {
      pos += 1;
      if (raw[pos] === "+" || raw[pos] === "-") pos += 1;
      if (pos >= raw.length || raw[pos]! < "0" || raw[pos]! > "9") return undefined;
      while (pos < raw.length && raw[pos]! >= "0" && raw[pos]! <= "9") pos += 1;
    }
    return { kind: "primitive", start, end: pos };
  };
  const parseValue = (depth: number): JsonNode | undefined => {
    if (depth > MAX_JSON_SPAN_DEPTH) return undefined;
    skipWs();
    if (pos >= raw.length) return undefined;
    const ch = raw[pos];
    if (ch === '"') return parseString();
    if (ch === "{") {
      const start = pos;
      pos += 1;
      skipWs();
      const entries: Array<{ key: JsonStringNode; value: JsonNode }> = [];
      if (raw[pos] === "}") {
        pos += 1;
        return { kind: "object", start, end: pos, entries };
      }
      while (true) {
        skipWs();
        const key = parseString();
        if (!key) return undefined;
        skipWs();
        if (raw[pos] !== ":") return undefined;
        pos += 1;
        const value = parseValue(depth + 1);
        if (!value) return undefined;
        entries.push({ key, value });
        skipWs();
        if (raw[pos] === "}") {
          pos += 1;
          return { kind: "object", start, end: pos, entries };
        }
        if (raw[pos] !== ",") return undefined;
        pos += 1;
      }
    }
    if (ch === "[") {
      const start = pos;
      pos += 1;
      skipWs();
      const items: JsonNode[] = [];
      if (raw[pos] === "]") {
        pos += 1;
        return { kind: "array", start, end: pos, items };
      }
      while (true) {
        const item = parseValue(depth + 1);
        if (!item) return undefined;
        items.push(item);
        skipWs();
        if (raw[pos] === "]") {
          pos += 1;
          return { kind: "array", start, end: pos, items };
        }
        if (raw[pos] !== ",") return undefined;
        pos += 1;
      }
    }
    return parsePrimitive();
  };
  const root = parseValue(0);
  if (!root) return undefined;
  skipWs();
  return pos === raw.length ? root : undefined;
}

function hasExactSortedRange(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [rStart, rEnd] = ranges[mid]!;
    if (rStart < start) lo = mid + 1;
    else if (rStart > start) hi = mid - 1;
    else return rEnd === end;
  }
  return false;
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

function redactValidJsonDocument(
  raw: string,
  root: JsonNode,
  options: {
    redactString: (text: string) => string;
    redactPrimitive: (text: string) => string;
    quoteMatches?: ReadonlyArray<readonly [number, number]>;
    checkContainerCallback?: (slice: string) => boolean;
    checkRawOuterQuotes?: boolean;
  },
): string | undefined {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const exactNodeSpans = new Set<string>();
  const stringSpans: Array<readonly [number, number]> = [];
  const quoteMatches = options.quoteMatches ?? [];
  let containerBudget = Math.max(16_384, raw.length * 4);

  const visit = (node: JsonNode, isRoot: boolean): void => {
    if (quoteMatches.length > 0 && hasExactSortedRange(quoteMatches, node.start, node.end)) {
      exactNodeSpans.add(`${node.start}:${node.end}`);
      replacements.push({
        start: node.start,
        end: node.end,
        text: isRoot && node.kind === "primitive" ? "[redacted]" : '"[redacted]"',
      });
      return;
    }
    if (node.kind === "object" || node.kind === "array") {
      const length = node.end - node.start;
      if (options.checkContainerCallback && length <= containerBudget) {
        containerBudget -= length;
        if (options.checkContainerCallback(raw.slice(node.start, node.end))) {
          replacements.push({
            start: node.start,
            end: node.end,
            text: '"[redacted]"',
          });
          return;
        }
      }
      if (node.kind === "array") {
        for (const item of node.items) visit(item, false);
      } else {
        for (const entry of node.entries) {
          visit(entry.key, false);
          visit(entry.value, false);
        }
      }
      return;
    }
    if (node.kind === "string") {
      stringSpans.push([node.start, node.end]);
      const token = raw.slice(node.start, node.end);
      const decoded: unknown = JSON.parse(token);
      if (typeof decoded === "string") {
        const next = options.redactString(decoded);
        if (next !== decoded) {
          replacements.push({ start: node.start, end: node.end, text: JSON.stringify(next) });
          return;
        }
        if (options.checkRawOuterQuotes) {
          const rawRedacted = options.redactString(token);
          if (
            rawRedacted !== token &&
            (!rawRedacted.startsWith('"') || !rawRedacted.endsWith('"'))
          ) {
            replacements.push({
              start: node.start,
              end: node.end,
              text: JSON.stringify(rawRedacted),
            });
          }
        }
      }
      return;
    }
    const token = raw.slice(node.start, node.end);
    const next = options.redactPrimitive(token);
    if (next !== token) {
      replacements.push({
        start: node.start,
        end: node.end,
        text: isRoot ? next : JSON.stringify(next),
      });
    }
  };

  visit(root, true);

  // If a registered quote-containing secret crosses a JSON node boundary (neither an exact node
  // match nor strictly inside a string literal's interior), fall back so it cannot survive.
  if (quoteMatches.length > 0) {
    let strIdx = 0;
    for (const [mStart, mEnd] of quoteMatches) {
      if (exactNodeSpans.has(`${mStart}:${mEnd}`)) continue;
      while (strIdx < stringSpans.length && stringSpans[strIdx]![1] <= mStart) strIdx += 1;
      const enclosing = stringSpans[strIdx];
      if (!enclosing || !(enclosing[0] < mStart && mEnd < enclosing[1])) {
        return undefined;
      }
    }
  }

  if (replacements.length === 0) return raw;
  let out = "";
  let cursor = 0;
  for (const rep of replacements) {
    if (rep.start > cursor) out += raw.slice(cursor, rep.start);
    out += rep.text;
    cursor = rep.end;
  }
  if (cursor < raw.length) out += raw.slice(cursor);
  return out;
}

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
  while (prev >= 0 && isJsonWhitespace(raw[prev])) prev -= 1;
  if (prev < 0 || raw[prev] !== ":") return true;
  prev -= 1;
  while (prev >= 0 && isJsonWhitespace(raw[prev])) prev -= 1;
  return prev < 0 ? leadingQuote : raw[prev] === '"';
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
  if (!closed || end >= raw.length) return true;
  const ch = raw[end];
  // Accept whitespace or structural/diagnostic delimiters right after the closing quote (such as
  // JSON Lines or `Response body: "s\u00e9cret" (HTTP 400)`), while keeping glued broken-quote
  // diagnostics like `Error: "a"b"` intact for plain-text matching.
  return (
    isJsonWhitespace(ch) ||
    ch === ":" ||
    ch === "," ||
    ch === "}" ||
    ch === "]" ||
    ch === ")" ||
    ch === ";"
  );
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
      // Keep strings after an unquoted diagnostic label (`fixture: "opaque-123"` or
      // `fixture:\n"opaque-123"`) in the plain-text gap when the token didn't change on its own
      // or when a wider registered secret spans across the label and opening quote.
      if (!isStrictJsonColon(chunk, index, leadingQuote)) {
        if (replaced === token) continue;
        const prefix = chunk.slice(cursor, index);
        const redactedPrefix = redact(prefix);
        const combined = redact(chunk.slice(cursor, end));
        if (!combined.startsWith(redactedPrefix)) continue;
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
  const quoteSecrets = wholeSecrets?.filter((value) => value.includes('"')) ?? [];
  const quoteMatches = quoteSecrets.length > 0 ? createSecretMatcher(quoteSecrets).ranges(raw) : [];
  const parsedRoot = parseJsonSpans(raw);
  if (parsedRoot) {
    const redactedJson = redactValidJsonDocument(raw, parsedRoot, {
      redactString,
      redactPrimitive: redactPlain,
      quoteMatches,
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  if (!raw.includes('"')) return redactPlain(raw);
  let out = "";
  let cursor = 0;
  for (const match of raw.matchAll(JSON_STRING_LITERAL_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    const end = index + token.length;
    const closed = isClosedJsonStringToken(token);
    // Plain diagnostics such as `Bearer "secret"`, `Bearer\n "secret"`, or `Error: "a"b"` do not
    // sit between JSON structural delimiters, and a registered secret crossing a quote must stay
    // intact in `redactPlain`.
    if (
      !precedesJsonStringToken(raw, index) ||
      !followsJsonStringToken(raw, end, closed) ||
      (quoteMatches.length > 0 &&
        (overlapsSortedRange(quoteMatches, index, index + 1) ||
          (closed && overlapsSortedRange(quoteMatches, end - 1, end))))
    ) {
      continue;
    }
    if (index > cursor) out += redactPlain(raw.slice(cursor, index));
    out += redactSingleJsonStringToken(token, redactString, redactPlain);
    cursor = end;
  }
  if (cursor < raw.length) out += redactPlain(raw.slice(cursor));
  return out;
}

export function redactJsonText(raw: string, redact: (text: string) => string): string {
  const parsedRoot = parseJsonSpans(raw);
  if (parsedRoot) {
    const hasRawMatch = redact(raw) !== raw;
    const redactedJson = redactValidJsonDocument(raw, parsedRoot, {
      redactString: redact,
      redactPrimitive: redact,
      checkRawOuterQuotes: hasRawMatch,
      ...(hasRawMatch
        ? { checkContainerCallback: (slice: string) => redact(slice) === "[redacted]" }
        : {}),
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  return redactJsonStringTokens(raw, redact);
}
