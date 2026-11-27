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
 * Redact Bearer tokens without consuming JSON structural delimiters (`:`, `,`, `}`, `]`).
 * `[redacted]` stays in place only when it is the whole token. A suffix such as `FixtureTail`
 * or `\fixtureTail` is still masked. A later pass does not grow another `]`.
 *
 * Raw text treats a JSON escape (`\\`, `\"`, `\n`, `\r`, `\t`) as the end of the token, so a
 * saved JSON string stays valid. `decoded` is for text JSON.parse already returned. A backslash
 * and the next non-whitespace character are one token atom, including `\"` and `\\`. A bare `"`
 * still ends the token. Each atom is disjoint, so the scan stays linear.
 */
const ADJACENT_CREDENTIAL_START =
  /(?:Bearer\s|(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth)\s*[=:])/;
const JSON_CONTAINER_LINE_START =
  /(?:\{\s*(?:["}]|$)|\[\s*(?:["{[\]]|(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[\s,\]]|$)))/;
const RAW_JSON_CONTAINER_START =
  /(?:\{(?:\s|\\[nrt])*(?:\\*"|\}|$)|\[(?:\s|\\[nrt])*(?:\\*"|[{[\]]|(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s|\\[nrt]|[,\]$])))/;
const RAW_ESCAPED_QUOTED_VALUE = /\\(?:\\\\)*"(?!\\")[^\S\r\n]*(?!\\")[^"\s\r\n]/;
const RAW_QUOTED_VALUE = /"(?!\s*[:,}\]\r\n]|$)[^"\r\n]+"|'[^'"\r\n]+'/;
const RAW_ASSIGNED_VALUE = new RegExp(
  `(?:${RAW_ESCAPED_QUOTED_VALUE.source}|${RAW_QUOTED_VALUE.source}|\\\\(?:\\\\|(?![nrt"]))|[^\\s"',;&\\\\])`,
);
const RAW_MID_VALUE_SPLIT = /(?:\\(?![nrt"\\])|[^\s"'\\,;&}:\]])*(?:[:}\]]|\\\\)[^\s"',;&]/;
const RAW_SPLITTING_CREDENTIAL_KEY = new RegExp(
  `[\\w-]*(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth)\\s*(?::(?:\\s|\\\\[nrt])*${RAW_ASSIGNED_VALUE.source}|=(?:(?:\\s|\\\\[nrt])+${RAW_ASSIGNED_VALUE.source}|${RAW_ESCAPED_QUOTED_VALUE.source}|${RAW_QUOTED_VALUE.source}|${RAW_MID_VALUE_SPLIT.source}))`,
);
const DECODED_QUOTED_VALUE = /"[^"\r\n]+"|'[^'\r\n]+'/;
const DECODED_ASSIGNED_VALUE = new RegExp(`(?:[^\\s"',;&]|${DECODED_QUOTED_VALUE.source})`);
const DECODED_MID_VALUE_SPLIT = /[^\s"',;&}:\]]*[:}\]][^\s"',;&]/;
const DECODED_SPLITTING_CREDENTIAL_KEY = new RegExp(
  `[\\w-]*(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth)\\s*(?::\\s*${DECODED_ASSIGNED_VALUE.source}|=(?:\\s+${DECODED_ASSIGNED_VALUE.source}|${DECODED_QUOTED_VALUE.source}|${DECODED_MID_VALUE_SPLIT.source}))`,
);
const RAW_DEFERRED_BEARER_FOLLOWS = new RegExp(
  `Bearer(?:[^\\S\\r\\n]+(?!(?:\\s|\\\\[nrt]|\\S*Bearer(?:\\s|\\\\[nrt])+\\S|${RAW_SPLITTING_CREDENTIAL_KEY.source}))\\S|\\s+(?!(?:\\s|\\\\[nrt]|${JSON_CONTAINER_LINE_START.source}|\\S*Bearer(?:\\s|\\\\[nrt])+\\S|${RAW_SPLITTING_CREDENTIAL_KEY.source}))\\S|\\s*\\\\[nrt](?:\\s|\\\\[nrt])*(?!(?:\\s|\\\\[nrt]|${RAW_JSON_CONTAINER_START.source}|\\S*Bearer(?:\\s|\\\\[nrt])+\\S|${RAW_SPLITTING_CREDENTIAL_KEY.source}))(?:\\\\"|'|\\\\(?![nrt"\\\\])|[^\\s"',;&}:\\]\\\\]))`,
);
const DECODED_DEFERRED_BEARER_FOLLOWS = new RegExp(
  `Bearer(?:[^\\S\\r\\n]+(?!(?:\\s|\\S*Bearer\\s+\\S|${DECODED_SPLITTING_CREDENTIAL_KEY.source}))\\S|\\s+(?!(?:\\s|${JSON_CONTAINER_LINE_START.source}|\\S*Bearer\\s+\\S|${DECODED_SPLITTING_CREDENTIAL_KEY.source}))\\S)`,
);
const RAW_ATOM = /(?:\\(?![nrt"\\])|[^\s"',;&}:\]\\])/;
const RAW_SUFFIX_ATOM = new RegExp(
  `(?:(?!${ADJACENT_CREDENTIAL_START.source})(?:\\\\(?![nrt"\\\\])|[^\\s"',;&}{[\\]:\\\\]))`,
);
const RAW_BEARER = new RegExp(
  `Bearer\\s+(?!${RAW_DEFERRED_BEARER_FOLLOWS.source}|${RAW_SPLITTING_CREDENTIAL_KEY.source}|\\[redacted\\](?!${RAW_SUFFIX_ATOM.source}))(?:\\\\"(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^"\\r\\n]|[^"\\\\\\r\\n])+(?:\\\\"${RAW_SUFFIX_ATOM.source}*)?|"(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^"\\\\\\r\\n])+(?:"${RAW_SUFFIX_ATOM.source}*)?|'(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^'"\\\\\\r\\n])+(?:'${RAW_SUFFIX_ATOM.source}*)?|\\[redacted\\]${RAW_SUFFIX_ATOM.source}+|(?:${RAW_ATOM.source})+)`,
  "gi",
);

const DECODED_ATOM = /(?:\\[^\s]|\\(?=\s|$)|[^\s"',;&}:\]\\])/;
const DECODED_SUFFIX_ATOM = new RegExp(
  `(?:(?!${ADJACENT_CREDENTIAL_START.source})(?:\\\\[^\\s]|\\\\(?=\\s|$)|[^\\s"',;&}{[\\]:\\\\]))`,
);
const DECODED_BEARER = new RegExp(
  `Bearer\\s+(?!${DECODED_DEFERRED_BEARER_FOLLOWS.source}|${DECODED_SPLITTING_CREDENTIAL_KEY.source}|\\[redacted\\](?!${DECODED_SUFFIX_ATOM.source}))(?:"(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^"\\\\\\r\\n])+(?:"${DECODED_SUFFIX_ATOM.source}*)?|'(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^'\\\\\\r\\n])+(?:'${DECODED_SUFFIX_ATOM.source}*)?|\\[redacted\\]${DECODED_SUFFIX_ATOM.source}+|(?:${DECODED_ATOM.source})+)`,
  "gi",
);

const ESCAPED_WS_BEARER_RE = /Bearer\s*\\[nrt](?:\s|\\[nrt])*/gi;
const ESCAPED_BEARER_NEXT_STICKY = /Bearer(?:\s|\\[nrt])+/iy;
const RAW_JSON_CONTAINER_STICKY = new RegExp(RAW_JSON_CONTAINER_START.source, "y");
const RAW_SPLITTING_CREDENTIAL_STICKY = new RegExp(RAW_SPLITTING_CREDENTIAL_KEY.source, "iy");
const RAW_SUFFIX_ATOM_STICKY = new RegExp(RAW_SUFFIX_ATOM.source, "y");

function isRawJsonEscapeBreak(text: string, pos: number): boolean {
  if (text[pos] !== "\\") return false;
  const next = text[pos + 1];
  return next === "n" || next === "r" || next === "t" || next === '"' || next === "\\";
}

/**
 * Linear scan for `Bearer` followed by JSON-escaped whitespace (`\n`, `\r`, `\t`), including mixed
 * literal and escaped whitespace, bounded to the enclosing JSON string.
 */
function redactRawEscapedWhitespaceBearers(text: string): string {
  if (!text.includes("\\")) return text;
  ESCAPED_WS_BEARER_RE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (
    let match = ESCAPED_WS_BEARER_RE.exec(text);
    match !== null;
    match = ESCAPED_WS_BEARER_RE.exec(text)
  ) {
    const start = match.index;
    const valueStart = start + match[0].length;
    if (valueStart >= text.length) break;
    if (text[valueStart] === '"') continue;
    ESCAPED_BEARER_NEXT_STICKY.lastIndex = valueStart;
    if (ESCAPED_BEARER_NEXT_STICKY.test(text)) continue;
    RAW_JSON_CONTAINER_STICKY.lastIndex = valueStart;
    if (RAW_JSON_CONTAINER_STICKY.test(text)) continue;
    RAW_SPLITTING_CREDENTIAL_STICKY.lastIndex = valueStart;
    if (RAW_SPLITTING_CREDENTIAL_STICKY.test(text)) continue;
    let end = valueStart;
    if (text.startsWith("[redacted]", valueStart)) {
      RAW_SUFFIX_ATOM_STICKY.lastIndex = valueStart + 10;
      if (!RAW_SUFFIX_ATOM_STICKY.test(text)) continue;
      end = valueStart + 10;
      while (end < text.length) {
        RAW_SUFFIX_ATOM_STICKY.lastIndex = end;
        if (!RAW_SUFFIX_ATOM_STICKY.test(text)) break;
        end = RAW_SUFFIX_ATOM_STICKY.lastIndex;
      }
    } else if (text[valueStart] === "\\" && text[valueStart + 1] === '"') {
      let cur = valueStart + 2;
      let closed = false;
      while (cur < text.length) {
        const ch = text[cur]!;
        if (ch === "\n" || ch === "\r" || ch === '"') break;
        if (ch === "\\") {
          const next = text[cur + 1];
          if (next === '"') {
            cur += 2;
            closed = true;
            break;
          }
          if (next === "n" || next === "r") break;
          cur += next === undefined ? 1 : 2;
          continue;
        }
        cur += 1;
      }
      if (closed) {
        while (cur < text.length) {
          RAW_SUFFIX_ATOM_STICKY.lastIndex = cur;
          if (!RAW_SUFFIX_ATOM_STICKY.test(text)) break;
          cur = RAW_SUFFIX_ATOM_STICKY.lastIndex;
        }
      }
      end = cur;
    } else if (text[valueStart] === "'") {
      let cur = valueStart + 1;
      let closed = false;
      while (cur < text.length) {
        const ch = text[cur]!;
        if (ch === "\n" || ch === "\r" || ch === '"') break;
        if (ch === "\\") {
          const next = text[cur + 1];
          if (next === "n" || next === "r" || next === '"') break;
          cur += next === undefined ? 1 : 2;
          continue;
        }
        cur += 1;
        if (ch === "'") {
          closed = true;
          break;
        }
      }
      if (closed) {
        while (cur < text.length) {
          RAW_SUFFIX_ATOM_STICKY.lastIndex = cur;
          if (!RAW_SUFFIX_ATOM_STICKY.test(text)) break;
          cur = RAW_SUFFIX_ATOM_STICKY.lastIndex;
        }
      }
      end = cur;
    } else {
      while (end < text.length) {
        const ch = text[end]!;
        if (/[\s"',;&}:\]]/.test(ch) || isRawJsonEscapeBreak(text, end)) break;
        end += 1;
      }
    }
    if (end <= valueStart) continue;
    out += `${text.slice(cursor, start)}Bearer [redacted]`;
    cursor = end;
    ESCAPED_WS_BEARER_RE.lastIndex = cursor;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

export function redactPlainBearerTokens(text: string, options?: { decoded?: boolean }): string {
  const pattern = options?.decoded ? DECODED_BEARER : RAW_BEARER;
  pattern.lastIndex = 0;
  const masked = text.replace(pattern, "Bearer [redacted]");
  return options?.decoded ? masked : redactRawEscapedWhitespaceBearers(masked);
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
  while (end >= 0 && /\s/.test(raw[end]!)) end -= 1;
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

function isPrecededByAssignmentSeparator(raw: string, index: number): boolean {
  let end = index - 1;
  while (end >= 0 && /\s/.test(raw[end]!)) end -= 1;
  return end >= 0 && (raw[end] === ":" || raw[end] === "=");
}

function followsJsonStringToken(raw: string, end: number, closed: boolean): boolean {
  if (!closed) {
    return (
      end >= raw.length ||
      (!isPrecededByBearer(raw, end) && !isPrecededByAssignmentSeparator(raw, end))
    );
  }
  if (end >= raw.length) return true;
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

/**
 * True when plain-text redaction matches line-by-line redaction, meaning no pattern spans a line
 * break (such as `Bearer\nsecret` or `password:\n  secret`).
 */
function plainRedactionMatchesByLine(
  raw: string,
  parts: readonly string[],
  redactPlain: (text: string) => string,
): boolean {
  const whole = redactPlain(raw);
  let joined = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    joined += index % 2 === 0 && part.length > 0 ? redactPlain(part) : part;
  }
  return joined === whole;
}

function lineEndsWithBearer(line: string): boolean {
  let end = line.length;
  while (end > 0 && /\s/.test(line[end - 1]!)) end -= 1;
  if (end < 6) return false;
  return line.slice(end - 6, end).toLowerCase() === "bearer";
}

function afterTrailingBearer(parts: readonly string[], index: number): boolean {
  for (let before = index - 2; before >= 0; before -= 2) {
    const line = parts[before]!;
    if (/\S/.test(line)) return lineEndsWithBearer(line);
  }
  return false;
}

/**
 * Redact standalone JSON object/array lines intact while running whole-stretch redaction on the
 * non-JSON stretches between them so an empty credential key cannot consume the next line's `{`.
 * A container line right after a line ending in `Bearer` (across any blank/whitespace lines)
 * stays in the stretch so cross-line Bearer redaction still sees it.
 */
function redactAroundJsonLines(
  parts: readonly string[],
  redactJsonLine: (line: string) => string,
  redactStretch: (stretch: string) => string,
): string {
  let out = "";
  let stretch = "";
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const separator = parts[index + 1] ?? "";
    if (/^\s*[{[]/.test(line) && parseJsonSpans(line) && !afterTrailingBearer(parts, index)) {
      if (stretch) out += redactStretch(stretch);
      stretch = "";
      out += `${redactJsonLine(line)}${separator}`;
    } else {
      stretch += `${line}${separator}`;
    }
  }
  if (stretch) out += redactStretch(stretch);
  return out;
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

function tryRedactJsonLines(
  raw: string,
  canSplitLines: (parts: readonly string[]) => boolean,
  redactLine: (line: string) => string,
  redactStretch?: (stretch: string) => string,
): string | undefined {
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
  if (!canSplitLines(parts)) {
    return redactStretch ? redactAroundJsonLines(parts, redactLine, redactStretch) : undefined;
  }
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
    const replaced = redactSingleJsonStringToken(token, redactString, redactPlain, rawTokenRanges);
    if (!isStrictJsonColon(raw, index, false) && replaced === token) continue;
    if (index > cursor) out += redactPlain(raw.slice(cursor, index));
    out += replaced;
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
    !anyRangeCrossesLineBreak(raw, rawMatches)
  ) {
    const byLine = tryRedactJsonLines(
      raw,
      (parts) => plainRedactionMatchesByLine(raw, parts, redactPlain),
      (line) =>
        redactJsonStringsAndPlainTextSingle(line, redactString, redactPlain, wholeSecrets, true),
      (stretch) =>
        redactJsonStringsAndPlainTextSingle(stretch, redactString, redactPlain, wholeSecrets),
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
  if (raw.includes("\n") && !BOUNDED_OMISSION_MARKER.test(raw)) {
    const byLine = tryRedactJsonLines(
      raw,
      (parts) => plainRedactionMatchesByLine(raw, parts, redact),
      (line) => redactJsonTextSingle(line, redact, true),
    );
    if (byLine !== undefined) return byLine;
  }
  return redactJsonStringTokens(raw, redact);
}
