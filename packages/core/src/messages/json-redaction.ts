import { createSecretMatcher } from "./secret-matcher.js";

const REDACTED_MARKER = "[redacted]";
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

function parseJsonSpans(
  raw: string,
): { root: JsonNode; nodesByStart: Map<number, JsonNode> } | undefined {
  let pos = 0;
  const nodesByStart = new Map<number, JsonNode>();
  const record = <T extends JsonNode>(node: T): T => {
    nodesByStart.set(node.start, node);
    return node;
  };
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
        return record({ kind: "string", start, end: pos });
      }
      pos += 1;
    }
    return undefined;
  };
  const parsePrimitive = (): (JsonNode & { kind: "primitive" }) | undefined => {
    const start = pos;
    if (raw.startsWith("true", pos) || raw.startsWith("null", pos)) {
      pos += 4;
      return record({ kind: "primitive", start, end: pos });
    }
    if (raw.startsWith("false", pos)) {
      pos += 5;
      return record({ kind: "primitive", start, end: pos });
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
    return record({ kind: "primitive", start, end: pos });
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
        return record({ kind: "object", start, end: pos, entries });
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
          return record({ kind: "object", start, end: pos, entries });
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
        return record({ kind: "array", start, end: pos, items });
      }
      while (true) {
        const item = parseValue(depth + 1);
        if (!item) return undefined;
        items.push(item);
        skipWs();
        if (raw[pos] === "]") {
          pos += 1;
          return record({ kind: "array", start, end: pos, items });
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
  return pos === raw.length ? { root, nodesByStart } : undefined;
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

function overlapsOutsideToken(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid]![1] <= start) lo = mid + 1;
    else hi = mid;
  }
  while (lo < ranges.length && ranges[lo]![0] < end) {
    const [rStart, rEnd] = ranges[lo]!;
    if (rStart < start || rEnd > end) return true;
    lo += 1;
  }
  return false;
}

function sliceRangesWithin(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid]![1] <= start) lo = mid + 1;
    else hi = mid;
  }
  const inside: Array<[number, number]> = [];
  while (lo < ranges.length && ranges[lo]![0] < end) {
    const [rStart, rEnd] = ranges[lo]!;
    if (rStart >= start && rEnd <= end) {
      inside.push([rStart - start, rEnd - start]);
    }
    lo += 1;
  }
  return inside;
}

function diffRedactedSpans(
  raw: string,
  rawRedacted: string,
  nodesByStart?: ReadonlyMap<number, JsonNode>,
  redact?: (text: string) => string,
): Array<[number, number]> | undefined {
  if (rawRedacted === raw) return [];
  const ranges: Array<[number, number]> = [];
  let r = 0;
  let o = 0;
  while (r < raw.length || o < rawRedacted.length) {
    while (r < raw.length && o < rawRedacted.length && raw[r] === rawRedacted[o]) {
      r += 1;
      o += 1;
    }
    if (r === raw.length && o === rawRedacted.length) break;
    // Back up across leading characters shared with "[redacted]" (such as "[" in an array secret).
    let markerStart = -1;
    const minBack = Math.max(0, o - (REDACTED_MARKER.length - 1));
    for (let cand = o; cand >= minBack; cand -= 1) {
      if (rawRedacted.startsWith(REDACTED_MARKER, cand)) {
        const delta = o - cand;
        if (r >= delta && raw.slice(r - delta, r) === rawRedacted.slice(cand, o)) {
          markerStart = cand;
          r -= delta;
          o = cand;
          break;
        }
      }
    }
    if (markerStart === -1) return undefined;
    const matchStart = r;
    o += REDACTED_MARKER.length;
    while (rawRedacted.startsWith(REDACTED_MARKER, o)) {
      o += REDACTED_MARKER.length;
    }
    const nextMarker = rawRedacted.indexOf(REDACTED_MARKER, o);
    if (nextMarker === -1) {
      const suffix = rawRedacted.slice(o);
      const matchEnd = raw.length - suffix.length;
      if (matchEnd < matchStart || !raw.endsWith(suffix)) return undefined;
      ranges.push([matchStart, matchEnd]);
      return ranges;
    }
    const gap = rawRedacted.slice(o, nextMarker);
    if (!gap) return undefined;
    let matchEnd = -1;
    const node = nodesByStart?.get(matchStart);
    if (
      node &&
      redact &&
      raw.startsWith(gap, node.end) &&
      redact(raw.slice(matchStart, node.end)) === REDACTED_MARKER
    ) {
      matchEnd = node.end;
    }
    if (matchEnd === -1) {
      const pos = raw.indexOf(gap, matchStart + 1);
      if (pos === -1) return undefined;
      matchEnd = pos;
    }
    ranges.push([matchStart, matchEnd]);
    r = matchEnd + gap.length;
    o = nextMarker;
  }
  return ranges;
}

function jsonStringEscapeBoundaries(token: string): Uint8Array {
  const ok = new Uint8Array(token.length + 1);
  ok[0] = 1;
  ok[token.length] = 1;
  let pos = 1;
  const end = token.length - 1;
  while (pos < end) {
    ok[pos] = 1;
    if (token[pos] === "\\") {
      pos += token[pos + 1] === "u" ? 6 : 2;
    } else {
      pos += 1;
    }
  }
  ok[end] = 1;
  return ok;
}

function isValidJsonStringLiteral(text: string): boolean {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return false;
  try {
    return typeof JSON.parse(text) === "string";
  } catch {
    return false;
  }
}

function redactRawStringToken(
  token: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): string {
  if (ranges.length === 0) return token;
  const boundaries = jsonStringEscapeBoundaries(token);
  const validRanges = ranges.filter(
    ([start, end]) =>
      start >= 0 &&
      end <= token.length &&
      start < end &&
      boundaries[start] === 1 &&
      boundaries[end] === 1,
  );
  if (validRanges.length === 0) return token;
  let out = "";
  let cursor = 0;
  for (const [start, end] of validRanges) {
    if (start > cursor) out += token.slice(cursor, start);
    out += REDACTED_MARKER;
    cursor = end;
  }
  if (cursor < token.length) out += token.slice(cursor);
  const touchedStart = validRanges[0]![0] === 0;
  const touchedEnd = validRanges.at(-1)![1] === token.length;
  if (!touchedStart && !touchedEnd) {
    return isValidJsonStringLiteral(out) ? out : JSON.stringify(REDACTED_MARKER);
  }
  if (isValidJsonStringLiteral(out)) return out;
  const trimmedStart = !touchedStart && out.startsWith('"') ? out.slice(1) : out;
  const trimmed =
    !touchedEnd && trimmedStart.endsWith('"') ? trimmedStart.slice(0, -1) : trimmedStart;
  return JSON.stringify(trimmed);
}

function applyReplacements(
  raw: string,
  replacements: ReadonlyArray<{ start: number; end: number; text: string }>,
): string {
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

function redactValidJsonDocument(
  raw: string,
  parsed: { root: JsonNode; nodesByStart: Map<number, JsonNode> },
  options: {
    redactString: (text: string) => string;
    redactPrimitive: (text: string) => string;
    rawMatches?: ReadonlyArray<readonly [number, number]>;
    rawTokenRanges?: (token: string) => ReadonlyArray<readonly [number, number]>;
    verifyBlackBox?: (text: string) => string;
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
          isRoot && node.kind === "primitive" ? REDACTED_MARKER : JSON.stringify(REDACTED_MARKER),
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
      const decoded: unknown = JSON.parse(token);
      if (typeof decoded === "string") {
        const afterDecoded = options.redactString(decoded);
        let candidate = afterDecoded === decoded ? token : JSON.stringify(afterDecoded);
        if (options.rawTokenRanges) {
          const tokenRanges =
            candidate === token && rawMatches !== undefined
              ? sliceRangesWithin(rawMatches, node.start, node.end)
              : options.rawTokenRanges(candidate);
          if (tokenRanges.length > 0) {
            candidate = redactRawStringToken(candidate, tokenRanges);
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
        text: isRoot ? next : JSON.stringify(next),
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
        ? diffRedactedSpans(out, verified, reparsed.nodesByStart, options.verifyBlackBox)
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
  try {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== "string") return fallbackPlain ? fallbackPlain(token) : token;
    const next = redact(decoded);
    let candidate = next === decoded ? token : JSON.stringify(next);
    if (rawTokenRanges) {
      const ranges = rawTokenRanges(candidate);
      if (ranges.length > 0) {
        candidate = redactRawStringToken(candidate, ranges);
      }
    }
    return candidate;
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
  const ch = raw[end]!;
  // Accept whitespace and structural or sentence punctuation (such as `. HTTP 400`, `;`, `)`,
  // `,`, `}`, `]`, `\n`), while keeping glued broken-quote diagnostics like `Error: "a"b"` intact.
  return isJsonWhitespace(ch) || !/[A-Za-z0-9_"\\]/.test(ch);
}

function blackBoxTokenRanges(
  redact: (text: string) => string,
): (candidate: string) => ReadonlyArray<readonly [number, number]> {
  return (candidate) => {
    const redacted = redact(candidate);
    if (redacted === candidate) return [];
    return diffRedactedSpans(candidate, redacted, undefined, redact) ?? [];
  };
}

function replaceJsonSegmentTokens(
  chunk: string,
  redact: (text: string) => string,
  leadingQuote = false,
): string {
  const chunkRedacted = redact(chunk);
  const rawMatches =
    chunkRedacted !== chunk ? diffRedactedSpans(chunk, chunkRedacted, undefined, redact) : [];
  const tokenRanges = blackBoxTokenRanges(redact);
  let out = "";
  let cursor = 0;
  let lastOverlapEnd = 0;
  for (const match of chunk.matchAll(JSON_VALUE_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    const end = index + token.length;
    if (token.startsWith('"')) {
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
  matcher: ReturnType<typeof createSecretMatcher> | undefined,
): string {
  const rawMatches = matcher ? matcher.ranges(raw) : [];
  const rawTokenRanges = matcher ? (candidate: string) => matcher.ranges(candidate) : undefined;
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
  if (!raw.includes('"')) return redactPlain(raw);
  let out = "";
  let cursor = 0;
  for (const match of raw.matchAll(JSON_STRING_LITERAL_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    const end = index + token.length;
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
  const matcher =
    wholeSecrets && wholeSecrets.length > 0 ? createSecretMatcher(wholeSecrets) : undefined;
  const rawMatches = matcher ? matcher.ranges(raw) : [];
  const rawTokenRanges = matcher ? (candidate: string) => matcher.ranges(candidate) : undefined;
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
      redactJsonStringsAndPlainTextSingle(line, redactString, redactPlain, matcher),
    );
    if (byLine !== undefined) return byLine;
  }
  return redactJsonStringsAndPlainTextSingle(raw, redactString, redactPlain, matcher);
}

function redactJsonTextSingle(raw: string, redact: (text: string) => string): string {
  const parsed = parseJsonSpans(raw);
  if (parsed) {
    const rawRedacted = redact(raw);
    const rawMatches =
      rawRedacted === raw ? [] : diffRedactedSpans(raw, rawRedacted, parsed.nodesByStart, redact);
    const redactedJson = redactValidJsonDocument(raw, parsed, {
      redactString: redact,
      redactPrimitive: redact,
      rawMatches,
      rawTokenRanges: blackBoxTokenRanges(redact),
      verifyBlackBox: redact,
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
      rawRedacted === raw ? [] : diffRedactedSpans(raw, rawRedacted, parsed.nodesByStart, redact);
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
    const byLine = tryRedactJsonLines(raw, (line) => redactJsonTextSingle(line, redact));
    if (byLine !== undefined) return byLine;
  }
  return redactJsonStringTokens(raw, redact);
}
