import { REDACTED_MARKER } from "./events.js";

const MAX_JSON_SPAN_DEPTH = 256;
const MAX_GAP_PROBES = 8;

export type JsonStringNode = { kind: "string"; start: number; end: number };
export type JsonNode =
  | JsonStringNode
  | { kind: "primitive"; start: number; end: number }
  | { kind: "array"; start: number; end: number; items: JsonNode[] }
  | {
      kind: "object";
      start: number;
      end: number;
      entries: Array<{ key: JsonStringNode; value: JsonNode }>;
    };

export function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

export function parseJsonSpans(
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

export function hasExactSortedRange(
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

export function overlapsOutsideToken(
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

export function sliceRangesWithin(
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

export function diffRedactedSpans(
  raw: string,
  rawRedacted: string,
  options: {
    nodesByStart?: ReadonlyMap<number, JsonNode>;
    boundaries?: Uint8Array;
    redact?: (text: string) => string;
  } = {},
): Array<[number, number]> | undefined {
  if (rawRedacted === raw) return [];
  const { nodesByStart, boundaries, redact } = options;
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
      let searchFrom = matchStart + 1;
      let probes = 0;
      let firstPos = -1;
      while (searchFrom <= raw.length - gap.length) {
        const pos = raw.indexOf(gap, searchFrom);
        if (pos === -1) break;
        if (firstPos === -1) firstPos = pos;
        if (boundaries && (boundaries[pos] !== 1 || boundaries[pos + gap.length] !== 1)) {
          searchFrom = pos + 1;
          continue;
        }
        if (redact) {
          probes += 1;
          if (probes > MAX_GAP_PROBES) return undefined;
          const sliceRedacted = redact(raw.slice(matchStart, pos));
          if (sliceRedacted === REDACTED_MARKER || /^(?:\[redacted\])+$/.test(sliceRedacted)) {
            matchEnd = pos;
            break;
          }
          searchFrom = pos + 1;
          continue;
        }
        matchEnd = pos;
        break;
      }
      if (matchEnd === -1) {
        if (redact || boundaries) return undefined;
        if (firstPos === -1) return undefined;
        matchEnd = firstPos;
      }
    }
    ranges.push([matchStart, matchEnd]);
    r = matchEnd + gap.length;
    o = nextMarker;
  }
  return ranges;
}

export function jsonStringEscapeBoundaries(token: string): Uint8Array {
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

export function isValidJsonStringLiteral(text: string): boolean {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return false;
  try {
    return typeof JSON.parse(text) === "string";
  } catch {
    return false;
  }
}

export function redactRawStringToken(
  token: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  maxEnd = token.length,
): string {
  if (ranges.length === 0) return token;
  const boundaries = jsonStringEscapeBoundaries(token);
  const validRanges = ranges.filter(
    ([start, end]) =>
      start >= 0 &&
      end <= maxEnd &&
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

export function applyReplacements(
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

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/** A `"` preceded by an odd number of backslashes is an escape, not the start of a string. */
function quoteIsEscaped(raw: string, index: number): boolean {
  let slashes = 0;
  for (let prev = index - 1; prev >= 0 && raw[prev] === "\\"; prev -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export type ScannedJsonToken = { start: number; end: number; isString: boolean };

/**
 * Scan single-line JSON-like string literals (and optionally JSON numbers) in strictly linear time
 * without regex backtracking. Matches unclosed strings up to the line break or end of input,
 * including a trailing backslash before a line break or EOF.
 */
export function scanJsonTokens(raw: string, includeNumbers: boolean): ScannedJsonToken[] {
  const tokens: ScannedJsonToken[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      if (quoteIsEscaped(raw, i)) {
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < raw.length) {
        const next = raw[end]!;
        if (next === '"') {
          end += 1;
          break;
        }
        if (next === "\r" || next === "\n") break;
        if (next === "\\") {
          if (end + 1 >= raw.length || raw[end + 1] === "\r" || raw[end + 1] === "\n") {
            end += 1;
            break;
          }
          end += 2;
          continue;
        }
        end += 1;
      }
      tokens.push({ start: i, end, isString: true });
      i = end;
      continue;
    }
    if (includeNumbers && (ch === "-" || isAsciiDigit(ch))) {
      let end = i;
      if (raw[end] === "-") end += 1;
      const intStart = end;
      while (end < raw.length && isAsciiDigit(raw[end])) end += 1;
      if (end === intStart) {
        i += 1;
        continue;
      }
      if (end + 1 < raw.length && raw[end] === "." && isAsciiDigit(raw[end + 1])) {
        end += 2;
        while (end < raw.length && isAsciiDigit(raw[end])) end += 1;
      }
      if (end < raw.length && (raw[end] === "e" || raw[end] === "E")) {
        let exp = end + 1;
        if (exp < raw.length && (raw[exp] === "+" || raw[exp] === "-")) exp += 1;
        const expDigits = exp;
        while (exp < raw.length && isAsciiDigit(raw[exp])) exp += 1;
        if (exp > expDigits) end = exp;
      }
      tokens.push({ start: i, end, isString: false });
      i = end;
      continue;
    }
    i += 1;
  }
  return tokens;
}
