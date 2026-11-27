import { REDACTED_MARKER, redactedRanges } from "./events.js";
import type { JsonNode } from "./json-spans.js";
import {
  applyReplacements,
  diffRedactedSpans,
  hasExactSortedRange,
  isJsonWhitespace,
  isValidJsonStringLiteral,
  jsonStringEscapeBoundaries,
  overlapsOutsideToken,
  parseJsonSpans,
  redactRawStringToken,
  scanJsonTokens,
  sliceRangesWithin,
} from "./json-spans.js";

const BOUNDED_OMISSION_MARKER = /(\n… \[\d+ characters not kept\] …\n)/;

/**
 * Redact Bearer tokens in plain or raw JSON-like text, handling quoted, escaped-quote, and
 * newline-wrapped values without consuming JSON structural delimiters (`:`, `,`, `}`, `]`).
 * `[redacted]` stays in place only when it is the whole token. A suffix such as `FixtureTail`
 * or `\fixtureTail` is still masked. A backslash stays in the token unless a quote follows it.
 * A later pass does not grow another `]`.
 */
export function redactPlainBearerTokens(text: string): string {
  return text.replace(
    /Bearer\s+(?!\[redacted\](?!(?:\\(?!")|[^\s"',;&}:\]\\])))(?:\\"(?!\s*[:,}\]\r\n]|$)(?:\\[^"\r\n]|[^"\\\r\n])+(?:\\")?|"(?!\s*[:,}\]\r\n]|$)[^"\r\n]+"?|'(?!\s*[:,}\]\r\n]|$)[^'\r\n]+'?|\[redacted\](?:\\(?!")|[^\s"',;&}:\]\\])+|(?:\\(?!")|[^\s"',;&}:\]\\])+)/gi,
    "Bearer [redacted]",
  );
}

function blackBoxTokenRanges(
  redact: (text: string) => string,
): (candidate: string) => ReadonlyArray<readonly [number, number]> {
  return (candidate) => {
    const redacted = redact(candidate);
    if (redacted === candidate) return [];
    const boundaries = isValidJsonStringLiteral(candidate)
      ? jsonStringEscapeBoundaries(candidate)
      : undefined;
    return diffRedactedSpans(candidate, redacted, { boundaries, redact }) ?? [];
  };
}

function redactValidJsonDocument(
  raw: string,
  parsed: { root: JsonNode; nodesByStart: Map<number, JsonNode> },
  options: {
    redactString: (text: string) => string;
    redactPrimitive: (text: string) => string;
    rawMatches?: ReadonlyArray<readonly [number, number]>;
    rawTokenRanges?: (token: string) => ReadonlyArray<readonly [number, number]>;
    verifyBlackBox?: (text: string) => string;
    quoteRootPrimitive?: boolean;
  },
): string | undefined {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const handledExactSpans = new Set<string>();
  const leafSpans: Array<readonly [number, number]> = [];
  const rawMatches = options.rawMatches;

  const visit = (node: JsonNode, isRoot: boolean): void => {
    if (
      rawMatches &&
      rawMatches.length > 0 &&
      hasExactSortedRange(rawMatches, node.start, node.end)
    ) {
      handledExactSpans.add(`${node.start}:${node.end}`);
      replacements.push({
        start: node.start,
        end: node.end,
        text:
          isRoot && node.kind === "primitive" && !options.quoteRootPrimitive
            ? REDACTED_MARKER
            : JSON.stringify(REDACTED_MARKER),
      });
      return;
    }
    if (node.kind === "array") {
      for (const item of node.items) visit(item, false);
      return;
    }
    if (node.kind === "object") {
      for (const entry of node.entries) {
        visit(entry.key, false);
        visit(entry.value, false);
      }
      return;
    }
    leafSpans.push([node.start, node.end]);
    const token = raw.slice(node.start, node.end);
    if (node.kind === "string") {
      // Redact escape-aligned raw matches BEFORE decoding so re-serializing another redacted
      // secret in the same string cannot turn a raw escaped secret into its unescaped form.
      let rawCleaned = token;
      if (options.rawTokenRanges) {
        const rawRanges =
          rawMatches !== undefined
            ? sliceRangesWithin(rawMatches, node.start, node.end)
            : options.rawTokenRanges(token);
        if (rawRanges.length > 0) {
          rawCleaned = redactRawStringToken(token, rawRanges);
        }
      }
      const decoded: unknown = JSON.parse(rawCleaned);
      if (typeof decoded === "string") {
        const afterDecoded = options.redactString(decoded);
        let candidate = afterDecoded === decoded ? rawCleaned : JSON.stringify(afterDecoded);
        if (afterDecoded !== decoded && options.rawTokenRanges) {
          const afterRanges = options.rawTokenRanges(candidate);
          if (afterRanges.length > 0) {
            candidate = redactRawStringToken(candidate, afterRanges);
          }
        }
        if (candidate !== token) {
          replacements.push({ start: node.start, end: node.end, text: candidate });
        }
      }
      return;
    }
    const next = options.redactPrimitive(token);
    if (next !== token) {
      replacements.push({
        start: node.start,
        end: node.end,
        text: isRoot && !options.quoteRootPrimitive ? next : JSON.stringify(next),
      });
    }
  };

  visit(parsed.root, true);

  // If a raw registered secret crosses a JSON node boundary (neither an exact node match nor
  // contained within a single leaf token), fall back so it cannot survive unredacted.
  if (rawMatches && rawMatches.length > 0) {
    let leafIdx = 0;
    for (const [mStart, mEnd] of rawMatches) {
      if (handledExactSpans.has(`${mStart}:${mEnd}`)) continue;
      while (leafIdx < leafSpans.length && leafSpans[leafIdx]![1] <= mStart) leafIdx += 1;
      const enclosing = leafSpans[leafIdx];
      if (!enclosing || !(enclosing[0] <= mStart && mEnd <= enclosing[1])) {
        return undefined;
      }
    }
  }

  const out = applyReplacements(raw, replacements);
  if (options.verifyBlackBox && rawMatches === undefined) {
    const verified = options.verifyBlackBox(out);
    if (verified !== out) {
      const reparsed = parseJsonSpans(out);
      const remaining = reparsed
        ? diffRedactedSpans(out, verified, {
            nodesByStart: reparsed.nodesByStart,
            redact: options.verifyBlackBox,
          })
        : undefined;
      if (reparsed && remaining && remaining.length > 0) {
        return redactValidJsonDocument(out, reparsed, {
          ...options,
          rawMatches: remaining,
          verifyBlackBox: undefined,
        });
      }
      return undefined;
    }
  }
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
  rawTokenRanges?: (candidate: string) => ReadonlyArray<readonly [number, number]>,
): string {
  if (isValidJsonStringLiteral(token)) {
    let rawCleaned = token;
    if (rawTokenRanges) {
      const ranges = rawTokenRanges(token);
      if (ranges.length > 0) {
        rawCleaned = redactRawStringToken(token, ranges);
      }
    }
    try {
      const decoded: unknown = JSON.parse(rawCleaned);
      if (typeof decoded !== "string") return fallbackPlain ? fallbackPlain(token) : token;
      const next = redact(decoded);
      if (next === decoded) return rawCleaned;
      let candidate = JSON.stringify(next);
      if (rawTokenRanges) {
        const afterRanges = rawTokenRanges(candidate);
        if (afterRanges.length > 0) {
          candidate = redactRawStringToken(candidate, afterRanges);
        }
      }
      return candidate;
    } catch {
      return fallbackPlain ? fallbackPlain(token) : token;
    }
  }
  // Truncated trailing string literal in cut-off JSON (including a lone trailing backslash).
  const { trimmed, trailing: trailingEscape } = splitTrailingIncompleteJsonEscape(token);
  const closedToken = `${trimmed}"`;
  if (isValidJsonStringLiteral(closedToken)) {
    let rawCleaned = closedToken;
    if (rawTokenRanges) {
      const ranges = rawTokenRanges(closedToken);
      if (ranges.length > 0) {
        rawCleaned = redactRawStringToken(closedToken, ranges, trimmed.length);
      }
    }
    try {
      const decoded: unknown = JSON.parse(rawCleaned);
      if (typeof decoded !== "string") return fallbackPlain ? fallbackPlain(token) : token;
      const next = redact(decoded);
      if (next === decoded && rawCleaned === closedToken) return token;
      let encoded = next === decoded ? rawCleaned : JSON.stringify(next);
      if (next !== decoded && rawTokenRanges) {
        const afterRanges = rawTokenRanges(encoded);
        if (afterRanges.length > 0) {
          encoded = redactRawStringToken(encoded, afterRanges, encoded.length - 1);
        }
      }
      return `${encoded.slice(0, -1)}${trailingEscape}`;
    } catch {
      // Fall through to plain fallback below.
    }
  }
  if (!fallbackPlain) return token;
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return `"${fallbackPlain(token.slice(1, -1))}"`;
  }
  return fallbackPlain(token);
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
  const ch = raw[end]!;
  // Accept whitespace and structural or sentence punctuation (such as `. HTTP 400`, `;`, `)`,
  // `,`, `}`, `]`, `\n`), while keeping glued broken-quote diagnostics like `Error: "a"b"` intact.
  return isJsonWhitespace(ch) || !/[A-Za-z0-9_"\\]/.test(ch);
}

function replaceJsonSegmentTokens(
  chunk: string,
  redact: (text: string) => string,
  leadingQuote = false,
): string {
  const chunkRedacted = redact(chunk);
  const rawMatches =
    chunkRedacted !== chunk ? diffRedactedSpans(chunk, chunkRedacted, { redact }) : [];
  const tokenRanges = blackBoxTokenRanges(redact);
  let out = "";
  let cursor = 0;
  let lastOverlapEnd = 0;
  for (const { start: index, end, isString } of scanJsonTokens(chunk, true)) {
    const token = chunk.slice(index, end);
    if (isString) {
      if (
        !precedesJsonStringToken(chunk, index) ||
        !followsJsonStringToken(chunk, end, isClosedJsonStringToken(token)) ||
        (rawMatches && rawMatches.length > 0 && overlapsOutsideToken(rawMatches, index, end))
      ) {
        continue;
      }
      const replaced = redactSingleJsonStringToken(token, redact, redact, tokenRanges);
      // Keep strings after an unquoted diagnostic label (`fixture: "opaque-123"` or
      // `fixture:\n"opaque-123"`) in the plain-text gap when the token didn't change on its own
      // or when a wider secret spans across the label and opening quote; advance `lastOverlapEnd`
      // so repeated overlaps scan each slice once in O(n).
      if (!isStrictJsonColon(chunk, index, leadingQuote)) {
        if (replaced === token) continue;
        const windowStart = Math.max(cursor, lastOverlapEnd);
        const prefix = chunk.slice(windowStart, index);
        const redactedPrefix = redact(prefix);
        const combined = redact(chunk.slice(windowStart, end));
        if (!combined.startsWith(redactedPrefix)) {
          lastOverlapEnd = end;
          continue;
        }
      }
      if (index > cursor) out += redact(chunk.slice(cursor, index));
      out += replaced;
      cursor = end;
      lastOverlapEnd = end;
      continue;
    }
    if (rawMatches && rawMatches.length > 0 && overlapsOutsideToken(rawMatches, index, end)) {
      continue;
    }
    const replaced = redactJsonValueToken(token, index, chunk, redact);
    if (replaced !== token) {
      if (index > cursor) out += redact(chunk.slice(cursor, index));
      out += replaced;
      cursor = end;
      lastOverlapEnd = end;
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

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a || code === 0x0d) count += 1;
  }
  return count;
}

function anyRangeCrossesLineBreak(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x0a || code === 0x0d) return true;
    }
  }
  return false;
}

function looksLikeJsonLine(line: string): boolean {
  let pos = 0;
  while (pos < line.length && isJsonWhitespace(line[pos])) pos += 1;
  if (pos >= line.length) return false;
  const ch = line[pos]!;
  return ch === "{" || ch === "[" || ch === '"';
}

function tryRedactJsonLines(raw: string, redactLine: (line: string) => string): string | undefined {
  if (!raw.includes("\n")) return undefined;
  const parts = raw.split(/(\r?\n)/);
  let hasJsonLine = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (looksLikeJsonLine(line) && parseJsonSpans(line)) {
      hasJsonLine = true;
      break;
    }
  }
  if (!hasJsonLine) return undefined;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    if (line.length > 0) parts[index] = redactLine(line);
  }
  return parts.join("");
}

function redactJsonStringTokens(raw: string, redact: (text: string) => string): string {
  const parts = raw.split(BOUNDED_OMISSION_MARKER);
  if (parts.length === 1) return redactJsonSegment(raw, false, redact);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : redactJsonSegment(part, index > 0, redact)))
    .join("");
}

function redactJsonStringsAndPlainTextSingle(
  raw: string,
  redactString: (text: string) => string,
  redactPlain: (text: string) => string,
  wholeSecrets: readonly string[] | undefined,
  quoteRootPrimitive = false,
): string {
  const rawMatches =
    wholeSecrets && wholeSecrets.length > 0 ? redactedRanges(raw, wholeSecrets) : [];
  const rawTokenRanges =
    wholeSecrets && wholeSecrets.length > 0
      ? (candidate: string) => redactedRanges(candidate, wholeSecrets)
      : undefined;
  const parsed = parseJsonSpans(raw);
  if (parsed) {
    const redactedJson = redactValidJsonDocument(raw, parsed, {
      redactString,
      redactPrimitive: redactPlain,
      rawMatches,
      rawTokenRanges,
      quoteRootPrimitive,
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  if (!raw.includes('"')) return redactPlain(raw);
  let out = "";
  let cursor = 0;
  for (const { start: index, end } of scanJsonTokens(raw, false)) {
    const token = raw.slice(index, end);
    const closed = isClosedJsonStringToken(token);
    // Plain diagnostics such as `Bearer "secret"`, `Bearer\n "secret"`, or `Error: "a"b"` do not
    // sit between JSON structural delimiters, and a registered secret crossing outside a quote
    // must stay intact in `redactPlain`.
    if (
      !precedesJsonStringToken(raw, index) ||
      !followsJsonStringToken(raw, end, closed) ||
      (rawMatches.length > 0 && overlapsOutsideToken(rawMatches, index, end))
    ) {
      continue;
    }
    if (index > cursor) out += redactPlain(raw.slice(cursor, index));
    out += redactSingleJsonStringToken(token, redactString, redactPlain, rawTokenRanges);
    cursor = end;
  }
  if (cursor < raw.length) out += redactPlain(raw.slice(cursor));
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
  const rawMatches =
    wholeSecrets && wholeSecrets.length > 0 ? redactedRanges(raw, wholeSecrets) : [];
  const rawTokenRanges =
    wholeSecrets && wholeSecrets.length > 0
      ? (candidate: string) => redactedRanges(candidate, wholeSecrets)
      : undefined;
  const parsed = parseJsonSpans(raw);
  if (parsed) {
    const redactedJson = redactValidJsonDocument(raw, parsed, {
      redactString,
      redactPrimitive: redactPlain,
      rawMatches,
      rawTokenRanges,
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  if (
    raw.includes("\n") &&
    !BOUNDED_OMISSION_MARKER.test(raw) &&
    !anyRangeCrossesLineBreak(raw, rawMatches) &&
    countLineBreaks(redactPlain(raw)) === countLineBreaks(raw)
  ) {
    const byLine = tryRedactJsonLines(raw, (line) =>
      redactJsonStringsAndPlainTextSingle(line, redactString, redactPlain, wholeSecrets, true),
    );
    if (byLine !== undefined) return byLine;
  }
  return redactJsonStringsAndPlainTextSingle(raw, redactString, redactPlain, wholeSecrets);
}

function redactJsonTextSingle(
  raw: string,
  redact: (text: string) => string,
  quoteRootPrimitive = false,
): string {
  const parsed = parseJsonSpans(raw);
  if (parsed) {
    const rawRedacted = redact(raw);
    const rawMatches =
      rawRedacted === raw
        ? []
        : diffRedactedSpans(raw, rawRedacted, { nodesByStart: parsed.nodesByStart, redact });
    const redactedJson = redactValidJsonDocument(raw, parsed, {
      redactString: redact,
      redactPrimitive: redact,
      rawMatches,
      rawTokenRanges: blackBoxTokenRanges(redact),
      verifyBlackBox: redact,
      quoteRootPrimitive,
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  return redactJsonStringTokens(raw, redact);
}

export function redactJsonText(raw: string, redact: (text: string) => string): string {
  const parsed = parseJsonSpans(raw);
  if (parsed) {
    const rawRedacted = redact(raw);
    const rawMatches =
      rawRedacted === raw
        ? []
        : diffRedactedSpans(raw, rawRedacted, { nodesByStart: parsed.nodesByStart, redact });
    const redactedJson = redactValidJsonDocument(raw, parsed, {
      redactString: redact,
      redactPrimitive: redact,
      rawMatches,
      rawTokenRanges: blackBoxTokenRanges(redact),
      verifyBlackBox: redact,
    });
    if (redactedJson !== undefined) return redactedJson;
  }
  if (
    raw.includes("\n") &&
    !BOUNDED_OMISSION_MARKER.test(raw) &&
    countLineBreaks(redact(raw)) === countLineBreaks(raw)
  ) {
    const byLine = tryRedactJsonLines(raw, (line) => redactJsonTextSingle(line, redact, true));
    if (byLine !== undefined) return byLine;
  }
  return redactJsonStringTokens(raw, redact);
}
