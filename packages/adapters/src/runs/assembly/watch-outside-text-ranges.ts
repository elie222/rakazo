import { sliceWellFormed } from "@rakazo/core";
import { MAX_OUTSIDE_TEXT_CHARS } from "../../approvals/review-target-sources.js";
import { shortenToolResultText } from "../../runtime/context/context-selection.js";
import {
  OMITTED_AFTER_USE,
  OMITTED_BEFORE_USE,
  OMITTED_TEXT_BEFORE_USE,
} from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";

export const WATCH_ITEM_SIGNATURE = "item:";
export const OMISSION_MARKERS = [
  OMITTED_BEFORE_USE,
  OMITTED_TEXT_BEFORE_USE,
  OMITTED_AFTER_USE,
] as const;
export const WATCH_STATE_METADATA_KEYS = new Set([
  "checkedAt",
  "outcome",
  "retrying",
  "fingerprint",
  "entries",
  "detail",
]);

export interface WatchTextPart {
  text: string;
  isEntryValue?: boolean;
  itemSlice?: "fields" | "title";
}

export interface TextRange {
  start: number;
  end: number;
}

export function hasWatchOutsideContent(lastCheck: unknown): boolean {
  if (lastCheck == null) return false;
  if (typeof lastCheck === "string") return lastCheck.trim().length > 0;
  if (typeof lastCheck !== "object" || Array.isArray(lastCheck)) return true;
  const record = lastCheck as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.trim().length > 0) return true;
  if (
    record.entries &&
    typeof record.entries === "object" &&
    !Array.isArray(record.entries) &&
    Object.keys(record.entries).length > 0
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!WATCH_STATE_METADATA_KEYS.has(key) && value != null) return true;
  }
  return false;
}

export function collectRawWatchTextParts(
  root: unknown,
  parts: WatchTextPart[],
  maxChars = MAX_OUTSIDE_TEXT_CHARS,
): void {
  const stack: Array<{ node: unknown; isEntryValue: boolean; literal?: true }> = [
    { node: root, isEntryValue: false },
  ];
  let used = 0;
  const pushPart = (part: WatchTextPart) => {
    used += (parts.length === 0 ? 0 : 1) + part.text.length;
    parts.push(part);
  };
  while (stack.length > 0 && used <= maxChars) {
    const item = stack.pop()!;
    const { node, isEntryValue, literal } = item;
    if (literal && typeof node === "string") {
      pushPart({ text: node });
      continue;
    }
    if (typeof node === "string") {
      if (node.trim()) {
        pushPart(isEntryValue ? { text: node, isEntryValue: true } : { text: node });
      }
      continue;
    }
    if (typeof node === "number") {
      pushPart({ text: String(node) });
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], isEntryValue });
      }
      continue;
    }
    if (node && typeof node === "object") {
      if ((node as { type?: unknown }).type === "image") continue;
      const entries = Object.entries(node);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i]!;
        if (key === "entries" && child && typeof child === "object" && !Array.isArray(child)) {
          const watchEntries = Object.entries(child);
          for (let j = watchEntries.length - 1; j >= 0; j -= 1) {
            const [entryKey, entryValue] = watchEntries[j]!;
            stack.push({ node: entryValue, isEntryValue: true });
            if (entryKey.trim()) stack.push({ node: entryKey, isEntryValue: false, literal: true });
          }
        } else {
          stack.push({ node: child, isEntryValue });
        }
      }
    }
  }
}

export function unescapeJsonLayer(text: string): string {
  return text.replace(
    /\\(?:(["\\/bfnrt])|u([0-9a-fA-F]{4}))/g,
    (_match, simple?: string, hex?: string) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      switch (simple) {
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return simple ?? "";
      }
    },
  );
}

export function omissionMarkerIndex(text: string): number {
  let first = -1;
  for (const marker of OMISSION_MARKERS) {
    const index = text.indexOf(`\n${marker}\n`);
    if (index !== -1 && (first === -1 || index < first)) first = index;
  }
  return first;
}

function trimTrailingIncompleteJsonEscape(inner: string): string {
  const slashIdx = inner.lastIndexOf("\\");
  if (slashIdx >= 0 && inner.length - slashIdx <= 5) {
    let slashes = 0;
    for (let i = slashIdx; i >= 0 && inner[i] === "\\"; i -= 1) slashes += 1;
    if (slashes % 2 === 1) {
      const tail = inner.slice(slashIdx + 1);
      if (tail === "" || /^u[0-9a-fA-F]{0,3}$/.test(tail)) {
        return inner.slice(0, slashIdx);
      }
    }
  }
  return inner;
}

function advancePastLeadingIncompleteEscape(
  encoded: string,
  innerStart: number,
  innerEnd: number,
): number {
  let start = innerStart;
  if (start > 1 && start < innerEnd) {
    let slashes = 0;
    for (let i = start - 1; i >= 1 && encoded[i] === "\\"; i -= 1) slashes += 1;
    if (slashes % 2 === 1) {
      start = Math.min(innerEnd, start + (encoded[start] === "u" ? 5 : 1));
    } else {
      for (let k = Math.max(1, start - 5); k <= start - 2; k += 1) {
        if (encoded[k] !== "\\" || encoded[k + 1] !== "u") continue;
        let run = 0;
        for (let j = k; j >= 1 && encoded[j] === "\\"; j -= 1) run += 1;
        if (run % 2 === 1 && k + 6 > start) {
          start = Math.min(innerEnd, k + 6);
          break;
        }
      }
    }
  }
  if (start < innerEnd) {
    const code = encoded.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  }
  return start;
}

function decodeClippedJsonString(encoded: string, maxChars: number): string {
  if (encoded.length <= maxChars) {
    return JSON.parse(encoded) as string;
  }
  const innerLimit = maxChars - 1;
  if (innerLimit <= 0) return "";
  const inner = trimTrailingIncompleteJsonEscape(sliceWellFormed(encoded.slice(1), innerLimit));
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return inner;
  }
}

function pushJsonStringInRanges(
  encoded: string,
  rawValue: string,
  strStart: number,
  ranges: readonly TextRange[],
  parts: WatchTextPart[],
  isEntryValue = false,
): void {
  const strEnd = strStart + encoded.length;
  for (const range of ranges) {
    if (range.end <= strStart || range.start >= strEnd) continue;
    const localStart = Math.max(0, range.start - strStart);
    const localEnd = Math.min(encoded.length, range.end - strStart);
    if (localStart >= localEnd) continue;
    if (localStart === 0 && localEnd === encoded.length) {
      if (rawValue.trim()) {
        parts.push(isEntryValue ? { text: rawValue, isEntryValue: true } : { text: rawValue });
      }
      continue;
    }
    if (localStart === 0) {
      const delivered = decodeClippedJsonString(encoded, localEnd);
      if (delivered.trim()) {
        parts.push(isEntryValue ? { text: delivered, isEntryValue: true } : { text: delivered });
      }
      continue;
    }
    const rawInnerStart = Math.max(1, localStart);
    const innerEnd = Math.min(encoded.length - 1, localEnd);
    const innerStart = advancePastLeadingIncompleteEscape(encoded, rawInnerStart, innerEnd);
    if (innerStart >= innerEnd) continue;
    const inner = trimTrailingIncompleteJsonEscape(
      sliceWellFormed(encoded.slice(innerStart, innerEnd), innerEnd - innerStart),
    );
    if (!inner) continue;
    let decoded: string;
    try {
      decoded = JSON.parse(`"${inner}"`) as string;
    } catch {
      decoded = unescapeJsonLayer(inner);
    }
    if (!decoded.trim()) continue;
    if (isEntryValue && rawValue.startsWith(WATCH_ITEM_SIGNATURE)) {
      const titleSplit = rawValue.lastIndexOf(',"title":');
      const boundary = titleSplit !== -1 ? titleSplit : omissionMarkerIndex(rawValue);
      if (
        boundary !== -1 &&
        !decoded.includes(',"title":') &&
        omissionMarkerIndex(decoded) === -1
      ) {
        const encodedBoundaryOffset = JSON.stringify(rawValue.slice(0, boundary)).length - 1;
        parts.push({
          text: decoded,
          itemSlice: innerStart >= encodedBoundaryOffset ? "title" : "fields",
        });
      } else {
        parts.push({ text: decoded, itemSlice: "fields" });
      }
    } else {
      parts.push({ text: decoded });
    }
  }
}

function pushJsonNonStringInRanges(
  value: unknown,
  encoded: string,
  valStart: number,
  ranges: readonly TextRange[],
  parts: WatchTextPart[],
): void {
  const valEnd = valStart + encoded.length;
  for (const range of ranges) {
    if (range.end <= valStart || range.start >= valEnd) continue;
    const localStart = Math.max(0, range.start - valStart);
    const localEnd = Math.min(encoded.length, range.end - valStart);
    if (localStart >= localEnd) continue;
    if (localStart === 0 && localEnd === encoded.length) {
      collectRawWatchTextParts(value, parts, MAX_OUTSIDE_TEXT_CHARS);
    } else {
      const slice = sliceWellFormed(encoded.slice(localStart, localEnd), localEnd - localStart);
      if (slice.trim()) parts.push({ text: slice });
    }
  }
}

function collectDeliveredLastCheckParts(
  lastCheck: Record<string, unknown>,
  startPos: number,
  ranges: readonly TextRange[],
  maxEnd: number,
  parts: WatchTextPart[],
): number {
  let pos = startPos + 1;
  let first = true;
  for (const [key, value] of Object.entries(lastCheck)) {
    if (pos >= maxEnd) return pos;
    if (!first) pos += 1;
    first = false;
    pos += JSON.stringify(key).length + 1;
    if (pos >= maxEnd) return pos;
    if (key === "detail" && typeof value === "string") {
      const encoded = JSON.stringify(value);
      pushJsonStringInRanges(encoded, value, pos, ranges, parts);
      pos += encoded.length;
      continue;
    }
    if (key === "entries" && value && typeof value === "object" && !Array.isArray(value)) {
      pos += 1;
      let firstEntry = true;
      for (const [entryKey, entryVal] of Object.entries(value as Record<string, unknown>)) {
        if (pos >= maxEnd) return pos;
        if (!firstEntry) pos += 1;
        firstEntry = false;
        const encodedKey = JSON.stringify(entryKey);
        pushJsonStringInRanges(encodedKey, entryKey, pos, ranges, parts);
        pos += encodedKey.length + 1;
        if (pos >= maxEnd) return pos;
        if (typeof entryVal === "string") {
          const encodedVal = JSON.stringify(entryVal);
          pushJsonStringInRanges(encodedVal, entryVal, pos, ranges, parts, true);
          pos += encodedVal.length;
        } else {
          const encodedVal = JSON.stringify(entryVal);
          pushJsonNonStringInRanges(entryVal, encodedVal, pos, ranges, parts);
          pos += encodedVal.length;
        }
      }
      pos += 1;
      continue;
    }
    const encoded = JSON.stringify(value);
    if (!WATCH_STATE_METADATA_KEYS.has(key) && value != null) {
      if (typeof value === "string") {
        pushJsonStringInRanges(encoded, value, pos, ranges, parts);
      } else {
        pushJsonNonStringInRanges(value, encoded, pos, ranges, parts);
      }
    }
    pos += encoded.length;
  }
  return pos + 1;
}

export function extractDeliveredWatchPartsFromParsedJson(
  payload: unknown,
  ranges: readonly TextRange[],
): WatchTextPart[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const maxEnd = ranges.reduce((max, range) => Math.max(max, range.end), 0);
  if (maxEnd <= 0) return [];
  const parts: WatchTextPart[] = [];
  let pos = 1;
  let firstTop = true;
  for (const [topKey, topVal] of Object.entries(payload as Record<string, unknown>)) {
    if (pos >= maxEnd) break;
    if (!firstTop) pos += 1;
    firstTop = false;
    pos += JSON.stringify(topKey).length + 1;
    if (pos >= maxEnd) break;
    if (topKey !== "routines" || !Array.isArray(topVal)) {
      pos += JSON.stringify(topVal).length;
      continue;
    }
    pos += 1;
    let firstRoutine = true;
    for (const routine of topVal) {
      if (pos >= maxEnd) break;
      if (!firstRoutine) pos += 1;
      firstRoutine = false;
      if (!routine || typeof routine !== "object" || Array.isArray(routine)) {
        pos += JSON.stringify(routine).length;
        continue;
      }
      pos += 1;
      let firstField = true;
      for (const [fieldKey, fieldVal] of Object.entries(routine as Record<string, unknown>)) {
        if (pos >= maxEnd) break;
        if (!firstField) pos += 1;
        firstField = false;
        pos += JSON.stringify(fieldKey).length + 1;
        if (pos >= maxEnd) break;
        if (fieldKey !== "lastCheck" || !hasWatchOutsideContent(fieldVal)) {
          pos += JSON.stringify(fieldVal).length;
          continue;
        }
        if (typeof fieldVal === "string") {
          const encoded = JSON.stringify(fieldVal);
          pushJsonStringInRanges(encoded, fieldVal, pos, ranges, parts);
          pos += encoded.length;
        } else if (fieldVal && typeof fieldVal === "object" && !Array.isArray(fieldVal)) {
          pos = collectDeliveredLastCheckParts(
            fieldVal as Record<string, unknown>,
            pos,
            ranges,
            maxEnd,
            parts,
          );
        } else {
          const encoded = JSON.stringify(fieldVal);
          pushJsonNonStringInRanges(fieldVal, encoded, pos, ranges, parts);
          pos += encoded.length;
        }
      }
      pos += 1;
    }
    pos += 1;
  }
  return parts;
}

function visibleRangesInCandidate(
  candidate: string,
  segments: readonly string[],
  jsonLimit: number,
): TextRange[] | undefined {
  if (segments.length < 2) return undefined;
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (!candidate.startsWith(first) || !candidate.endsWith(last)) return undefined;
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (!seg) continue;
    const at =
      i === 0
        ? 0
        : i === segments.length - 1
          ? candidate.length - seg.length
          : candidate.indexOf(seg, cursor);
    if (at < cursor) return undefined;
    const start = Math.min(at, jsonLimit);
    const end = Math.min(at + seg.length, jsonLimit);
    if (start < end) ranges.push({ start, end });
    cursor = at + seg.length;
  }
  return ranges;
}

export function extractVisibleWatchPartsFromPlainTextBeforeUse(
  savedText: string,
  details: unknown,
  options?: { allowAfterUseOnly?: boolean },
): WatchTextPart[][] | undefined {
  const beforeMarker = `\n${OMITTED_TEXT_BEFORE_USE}\n`;
  const afterMarker = `\n${OMITTED_AFTER_USE}\n`;
  if (
    !savedText.includes(beforeMarker) &&
    !(options?.allowAfterUseOnly && savedText.includes(afterMarker))
  ) {
    return undefined;
  }
  try {
    const raw = JSON.stringify(details);
    if (!raw) return undefined;
    const currentClip = clipToolResultText(raw);
    const structuredRaw =
      raw.length > TOOL_RESULT_TEXT_LIMIT
        ? shortenToolResultText(raw, TOOL_RESULT_TEXT_LIMIT)
        : raw;
    const structuredClip = clipToolResultText(structuredRaw);
    if (savedText === raw || savedText === currentClip || savedText === structuredClip) {
      return undefined;
    }
    const segments = savedText
      .split(beforeMarker)
      .flatMap((part) => part.split(`\n${OMITTED_AFTER_USE}\n`));
    const candidates: Array<{
      candidate: string;
      underlyingJson: string;
      jsonLimit: number;
    }> = [
      { candidate: currentClip, underlyingJson: raw, jsonLimit: TOOL_RESULT_TEXT_LIMIT },
      ...(structuredClip !== currentClip
        ? [
            {
              candidate: structuredClip,
              underlyingJson: structuredRaw,
              jsonLimit: TOOL_RESULT_TEXT_LIMIT,
            },
          ]
        : []),
      ...(raw.length > TOOL_RESULT_TEXT_LIMIT
        ? [{ candidate: raw, underlyingJson: raw, jsonLimit: raw.length }]
        : []),
    ];
    const partGroups: WatchTextPart[][] = [];
    let matched = false;
    for (const { candidate, underlyingJson, jsonLimit } of candidates) {
      const ranges = visibleRangesInCandidate(candidate, segments, jsonLimit);
      if (!ranges) continue;
      matched = true;
      if (ranges.length === 0) continue;
      const parsed: unknown = JSON.parse(underlyingJson);
      const parts = extractDeliveredWatchPartsFromParsedJson(parsed, ranges);
      if (parts.length > 0) partGroups.push(parts);
    }
    return matched ? partGroups : undefined;
  } catch {
    return undefined;
  }
}
