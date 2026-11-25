import type { AgentContextStrategy } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { sliceWellFormed } from "@rakazo/core";
import { MAX_OUTSIDE_TEXT_CHARS } from "../../approvals/review-target-sources.js";
import { shortenToolResultText } from "../../runtime/context/context-selection.js";
import {
  OMITTED_AFTER_USE,
  OMITTED_BEFORE_USE,
  OMITTED_TEXT_BEFORE_USE,
} from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import {
  deliveredToolResultText,
  serializeToolResult,
} from "../../runtime/pi/tools/pi-runtime-tools.js";

const WATCH_ITEM_SIGNATURE = "item:";
const OMISSION_MARKERS = [OMITTED_BEFORE_USE, OMITTED_TEXT_BEFORE_USE, OMITTED_AFTER_USE] as const;
const WATCH_STATE_METADATA_KEYS = new Set([
  "checkedAt",
  "outcome",
  "retrying",
  "fingerprint",
  "entries",
  "detail",
]);

interface WatchTextPart {
  text: string;
  isEntryValue?: boolean;
}

function hasWatchOutsideContent(lastCheck: unknown): boolean {
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

function collectRawWatchTextParts(
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

function takePrefixPartList(parts: readonly WatchTextPart[], maxChars: number): WatchTextPart[] {
  if (parts.length === 0 || maxChars <= 0) return [];
  const kept: WatchTextPart[] = [];
  let used = 0;
  for (const part of parts) {
    const needed = used === 0 ? part.text.length : part.text.length + 1;
    if (used + needed <= maxChars) {
      kept.push(part);
      used += needed;
      continue;
    }
    const remaining = maxChars - (used === 0 ? 0 : used + 1);
    if (remaining > 0) {
      const sliced = sliceWellFormed(part.text, remaining);
      kept.push(part.isEntryValue ? { text: sliced, isEntryValue: true } : { text: sliced });
    }
    break;
  }
  return kept;
}

function collectDecodedJsonStrings(
  root: unknown,
  parts: string[],
  budget: { remaining: number },
): void {
  const stack: unknown[] = [root];
  while (stack.length > 0 && budget.remaining > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.trim()) {
        const kept =
          value.length <= budget.remaining ? value : sliceWellFormed(value, budget.remaining);
        if (kept) {
          parts.push(kept);
          budget.remaining -= kept.length + 1;
        }
      }
      continue;
    }
    if (typeof value === "number") {
      const text = String(value);
      const kept = text.length <= budget.remaining ? text : sliceWellFormed(text, budget.remaining);
      if (kept) {
        parts.push(kept);
        budget.remaining -= kept.length + 1;
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
      continue;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i]!;
        stack.push(child);
        if (key.trim()) stack.push(key);
      }
    }
  }
}

function unescapeJsonLayer(text: string): string {
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

function omissionMarkerIndex(text: string): number {
  let first = -1;
  for (const marker of OMISSION_MARKERS) {
    const index = text.indexOf(`\n${marker}\n`);
    if (index !== -1 && (first === -1 || index < first)) first = index;
  }
  return first;
}

/**
 * Unescape a shortened or clipped `item:{"fields":[...],"title":...}` signature layer by layer:
 * `fields` entries carry two JSON string layers, while `title` carries one, so literal backslashes
 * before `n`/`r`/`t` (like `\notices@example.test`) stay intact instead of eating the next letter.
 */
function unescapeClippedWatchItem(text: string): string {
  const titleSplit = text.lastIndexOf(',"title":');
  if (titleSplit !== -1) {
    return `${unescapeJsonLayer(unescapeJsonLayer(text.slice(0, titleSplit)))}${unescapeJsonLayer(text.slice(titleSplit))}`;
  }
  // When structured shortening omits `,"title":` on a titled item, the head before the omission
  // marker comes from double-encoded `fields` while the tail comes from single-encoded `title`.
  const omittedSplit = omissionMarkerIndex(text);
  if (omittedSplit !== -1) {
    return `${unescapeJsonLayer(unescapeJsonLayer(text.slice(0, omittedSplit)))}${unescapeJsonLayer(text.slice(omittedSplit))}`;
  }
  return unescapeJsonLayer(unescapeJsonLayer(text));
}

/**
 * Decode tracked item signatures (`item:{fields, title}`) after applying the raw UTF-16 budget so
 * JSON escapes like `\n` before an email address do not fuse `n` onto the recipient in `outsideText`.
 */
function decodeWatchTextPart(part: WatchTextPart): string {
  if (!part.isEntryValue || !part.text.startsWith(WATCH_ITEM_SIGNATURE)) return part.text;
  try {
    const parsed: unknown = JSON.parse(part.text.slice(WATCH_ITEM_SIGNATURE.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { fields?: unknown; title?: unknown };
      const decoded: string[] = [];
      const budget = { remaining: MAX_OUTSIDE_TEXT_CHARS };
      if (Array.isArray(record.fields)) {
        for (const field of record.fields) {
          if (budget.remaining <= 0) break;
          if (typeof field === "string") {
            try {
              collectDecodedJsonStrings(JSON.parse(field), decoded, budget);
            } catch {
              if (field.trim()) {
                const kept =
                  field.length <= budget.remaining
                    ? field
                    : sliceWellFormed(field, budget.remaining);
                if (kept) {
                  decoded.push(kept);
                  budget.remaining -= kept.length + 1;
                }
              }
            }
          } else {
            collectDecodedJsonStrings(field, decoded, budget);
          }
        }
      }
      if (budget.remaining > 0 && record.title !== undefined && record.title !== null) {
        collectDecodedJsonStrings(record.title, decoded, budget);
      }
      if (decoded.length > 0) return decoded.join("\n");
    }
  } catch {
    // A shortened or clipped `item:` signature is no longer complete JSON; unescape in place.
  }
  return unescapeClippedWatchItem(part.text);
}

function formatBoundedWatchParts(parts: readonly WatchTextPart[], rawChecks: unknown[]): unknown[] {
  const decoded = parts.map(decodeWatchTextPart).filter((part) => part.trim().length > 0);
  return decoded.length > 0 ? [decoded.join("\n")] : rawChecks;
}

function extractWatchCheckTexts(
  routines: readonly unknown[],
  maxChars = MAX_OUTSIDE_TEXT_CHARS,
): unknown[] {
  const rawChecks: unknown[] = [];
  for (const routine of routines) {
    if (!routine || typeof routine !== "object") continue;
    const lastCheck = (routine as { lastCheck?: unknown }).lastCheck;
    if (hasWatchOutsideContent(lastCheck)) rawChecks.push(lastCheck);
  }
  if (rawChecks.length === 0) return [];
  const rawParts: WatchTextPart[] = [];
  collectRawWatchTextParts(rawChecks, rawParts, maxChars);
  if (rawParts.length === 0) return rawChecks;
  return formatBoundedWatchParts(takePrefixPartList(rawParts, maxChars), rawChecks);
}

function decodeClippedJsonString(encoded: string, maxChars: number): string {
  if (encoded.length <= maxChars) {
    return JSON.parse(encoded) as string;
  }
  const innerLimit = maxChars - 1;
  if (innerLimit <= 0) return "";
  let inner = sliceWellFormed(encoded.slice(1), innerLimit);
  // Trim an incomplete trailing `\uXXXX` escape or lone trailing `\` before decoding.
  const slashIdx = inner.lastIndexOf("\\");
  if (slashIdx >= 0 && inner.length - slashIdx <= 5) {
    let slashes = 0;
    for (let i = slashIdx; i >= 0 && inner[i] === "\\"; i -= 1) slashes += 1;
    if (slashes % 2 === 1) {
      const tail = inner.slice(slashIdx + 1);
      if (tail === "" || /^u[0-9a-fA-F]{0,3}$/.test(tail)) {
        inner = inner.slice(0, slashIdx);
      }
    }
  }
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return inner;
  }
}

function collectDeliveredLastCheckParts(
  lastCheck: Record<string, unknown>,
  startPos: number,
  limit: number,
  parts: WatchTextPart[],
): number {
  let pos = startPos + 1;
  let first = true;
  for (const [key, value] of Object.entries(lastCheck)) {
    if (pos >= limit) return pos;
    if (!first) pos += 1;
    first = false;
    pos += JSON.stringify(key).length + 1;
    if (pos >= limit) return pos;
    if (key === "detail" && typeof value === "string") {
      const encoded = JSON.stringify(value);
      const delivered = decodeClippedJsonString(encoded, limit - pos);
      if (delivered.trim()) parts.push({ text: delivered });
      pos += encoded.length;
      continue;
    }
    if (key === "entries" && value && typeof value === "object" && !Array.isArray(value)) {
      pos += 1;
      let firstEntry = true;
      for (const [entryKey, entryVal] of Object.entries(value as Record<string, unknown>)) {
        if (pos >= limit) return pos;
        if (!firstEntry) pos += 1;
        firstEntry = false;
        const encodedKey = JSON.stringify(entryKey);
        const deliveredKey = decodeClippedJsonString(encodedKey, limit - pos);
        if (deliveredKey.trim()) parts.push({ text: deliveredKey });
        pos += encodedKey.length + 1;
        if (pos >= limit) return pos;
        if (typeof entryVal === "string") {
          const encodedVal = JSON.stringify(entryVal);
          const deliveredVal = decodeClippedJsonString(encodedVal, limit - pos);
          if (deliveredVal.trim()) parts.push({ text: deliveredVal, isEntryValue: true });
          pos += encodedVal.length;
        } else {
          const encodedVal = JSON.stringify(entryVal);
          if (pos + encodedVal.length <= limit) {
            collectRawWatchTextParts(entryVal, parts, limit - pos);
          } else {
            const slice = sliceWellFormed(encodedVal, limit - pos);
            if (slice.trim()) parts.push({ text: slice });
          }
          pos += encodedVal.length;
        }
      }
      pos += 1;
      continue;
    }
    const encoded = JSON.stringify(value);
    if (!WATCH_STATE_METADATA_KEYS.has(key) && value != null) {
      if (typeof value === "string") {
        const delivered = decodeClippedJsonString(encoded, limit - pos);
        if (delivered.trim()) parts.push({ text: delivered });
      } else if (pos + encoded.length <= limit) {
        collectRawWatchTextParts(value, parts, limit - pos);
      } else {
        const slice = sliceWellFormed(encoded, limit - pos);
        if (slice.trim()) parts.push({ text: slice });
      }
    }
    pos += encoded.length;
  }
  return pos + 1;
}

function extractDeliveredWatchPartsFromParsedJson(
  payload: unknown,
  limit: number,
): WatchTextPart[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const parts: WatchTextPart[] = [];
  let pos = 1;
  let firstTop = true;
  for (const [topKey, topVal] of Object.entries(payload as Record<string, unknown>)) {
    if (pos >= limit) break;
    if (!firstTop) pos += 1;
    firstTop = false;
    pos += JSON.stringify(topKey).length + 1;
    if (pos >= limit) break;
    if (topKey !== "routines" || !Array.isArray(topVal)) {
      pos += JSON.stringify(topVal).length;
      continue;
    }
    pos += 1;
    let firstRoutine = true;
    for (const routine of topVal) {
      if (pos >= limit) break;
      if (!firstRoutine) pos += 1;
      firstRoutine = false;
      if (!routine || typeof routine !== "object" || Array.isArray(routine)) {
        pos += JSON.stringify(routine).length;
        continue;
      }
      pos += 1;
      let firstField = true;
      for (const [fieldKey, fieldVal] of Object.entries(routine as Record<string, unknown>)) {
        if (pos >= limit) break;
        if (!firstField) pos += 1;
        firstField = false;
        pos += JSON.stringify(fieldKey).length + 1;
        if (pos >= limit) break;
        if (fieldKey !== "lastCheck" || !hasWatchOutsideContent(fieldVal)) {
          pos += JSON.stringify(fieldVal).length;
          continue;
        }
        if (typeof fieldVal === "string") {
          const encoded = JSON.stringify(fieldVal);
          const delivered = decodeClippedJsonString(encoded, limit - pos);
          if (delivered.trim()) parts.push({ text: delivered });
          pos += encoded.length;
        } else if (fieldVal && typeof fieldVal === "object" && !Array.isArray(fieldVal)) {
          pos = collectDeliveredLastCheckParts(
            fieldVal as Record<string, unknown>,
            pos,
            limit,
            parts,
          );
        } else {
          const encoded = JSON.stringify(fieldVal);
          if (pos + encoded.length <= limit) {
            collectRawWatchTextParts(fieldVal, parts, limit - pos);
          } else {
            const slice = sliceWellFormed(encoded, limit - pos);
            if (slice.trim()) parts.push({ text: slice });
          }
          pos += encoded.length;
        }
      }
      pos += 1;
    }
    pos += 1;
  }
  return parts;
}

/**
 * Extract the outside content carried by stored routine watch checks (`lastCheck`), including
 * `entries` keys (which hold tracked item identities or file paths that `outsideTextOf` skips
 * when walking object values). Checks without `entries` or `detail` carry no outside text. Mirrors
 * Pi's exact delivered representation (`deliveredToolResultText`), so verbatim tool results
 * keep full checks up to `MAX_OUTSIDE_TEXT_CHARS` while clipped results record only
 * the watch check content that actually fits within `TOOL_RESULT_TEXT_LIMIT`.
 */
export function storedWatchCheckOutsideContent(
  routines: readonly unknown[],
  contextStrategy?: AgentContextStrategy,
  delivery?: { name: string; args?: Record<string, unknown>; payload?: unknown },
): unknown[] {
  const hasChecks = routines.some(
    (routine) =>
      routine &&
      typeof routine === "object" &&
      hasWatchOutsideContent((routine as { lastCheck?: unknown }).lastCheck),
  );
  if (!hasChecks) return [];
  const name = delivery?.name ?? "schedule_list";
  const args = delivery?.args ?? {};
  const payload = delivery?.payload ?? { routines };
  const delivered = deliveredToolResultText(payload, contextStrategy, name, args);
  try {
    const parsed: unknown = JSON.parse(delivered);
    if (parsed && typeof parsed === "object" && "routines" in parsed) {
      const deliveredRoutines = (parsed as { routines?: unknown }).routines;
      if (Array.isArray(deliveredRoutines)) {
        return extractWatchCheckTexts(deliveredRoutines, MAX_OUTSIDE_TEXT_CHARS);
      }
    }
  } catch {
    // `delivered` was clipped at TOOL_RESULT_TEXT_LIMIT; walk the unclipped JSON up to that cut.
  }
  const unclippedJson =
    (contextStrategy ?? DEFAULT_CONTEXT_STRATEGY) === "current"
      ? JSON.stringify(payload)
      : serializeToolResult(payload, contextStrategy, name, args);
  try {
    const unclipped: unknown = JSON.parse(unclippedJson);
    const parts = extractDeliveredWatchPartsFromParsedJson(unclipped, TOOL_RESULT_TEXT_LIMIT);
    if (parts.length === 0) return [];
    return formatBoundedWatchParts(takePrefixPartList(parts, MAX_OUTSIDE_TEXT_CHARS), []);
  } catch {
    return extractWatchCheckTexts(routines, TOOL_RESULT_TEXT_LIMIT);
  }
}

function toolMessageTexts(content: unknown): string[] {
  return typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
      : [];
}

type SavedWatchStrategy = AgentContextStrategy | "verbatim" | "both";

/**
 * Infer the delivery strategy that produced a saved checkpoint's tool result by comparing its
 * persisted text against `details`, so changing strategy while paused cannot lose evidence the
 * model already read, including after plain-text after-use compaction.
 */
function savedToolResultStrategy(
  message: { details?: unknown; content: unknown },
  fallback?: AgentContextStrategy,
): SavedWatchStrategy | undefined {
  const savedText = toolMessageTexts(message.content).join("\n");
  if (!savedText || message.details === undefined) return fallback;
  try {
    const raw = JSON.stringify(message.details);
    if (!raw || raw.length <= TOOL_RESULT_TEXT_LIMIT) return fallback;
    if (savedText === raw) return "verbatim";
    const currentClip = clipToolResultText(raw);
    if (savedText === currentClip) return "current";
    const structuredClip = clipToolResultText(shortenToolResultText(raw, TOOL_RESULT_TEXT_LIMIT));
    if (savedText === structuredClip) return DEFAULT_CONTEXT_STRATEGY;
    try {
      const parsed: unknown = JSON.parse(savedText);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { contextTruncated?: unknown }).contextTruncated === true
      ) {
        return DEFAULT_CONTEXT_STRATEGY;
      }
      return fallback;
    } catch {
      const markerSplit = `\n${OMITTED_AFTER_USE}\n`;
      const markerAt = savedText.indexOf(markerSplit);
      if (markerAt !== -1) {
        const head = savedText.slice(0, markerAt);
        const tail = savedText.slice(markerAt + markerSplit.length);
        const matchesVerbatim = raw.startsWith(head) && raw.endsWith(tail);
        const matchesCurrent = currentClip.startsWith(head) && currentClip.endsWith(tail);
        const matchesStructured = structuredClip.startsWith(head) && structuredClip.endsWith(tail);
        if (matchesVerbatim && !matchesCurrent && !matchesStructured) return "verbatim";
        if (matchesCurrent && !matchesStructured && !matchesVerbatim) return "current";
        if (matchesStructured && !matchesCurrent && !matchesVerbatim)
          return DEFAULT_CONTEXT_STRATEGY;
      }
      return "both";
    }
  } catch {
    // Fall back to the resuming executor's strategy if details cannot be serialized.
  }
  return fallback;
}

function parseWatchChecksFromToolMessageContent(
  content: unknown,
): { parsed: true; extracted: unknown[] } | { parsed: false; extracted: unknown[] } {
  const texts = toolMessageTexts(content);
  if (texts.length === 0) return { parsed: false, extracted: [] };
  const extracted: unknown[] = [];
  const unparsed: string[] = [];
  let parsedRoutines = false;
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "routines" in parsed) {
        const routines = (parsed as { routines?: unknown }).routines;
        if (Array.isArray(routines)) {
          parsedRoutines = true;
          extracted.push(...extractWatchCheckTexts(routines, MAX_OUTSIDE_TEXT_CHARS));
        }
      }
    } catch {
      unparsed.push(text);
    }
  }
  if (unparsed.length > 0) {
    try {
      const joined: unknown = JSON.parse(unparsed.join("\n"));
      if (joined && typeof joined === "object" && "routines" in joined) {
        const routines = (joined as { routines?: unknown }).routines;
        if (Array.isArray(routines)) {
          extracted.push(...extractWatchCheckTexts(routines, MAX_OUTSIDE_TEXT_CHARS));
          return { parsed: true, extracted };
        }
      }
      return { parsed: parsedRoutines, extracted };
    } catch {
      // Truncated or non-JSON tool output cannot be narrowed safely, so keep its text.
      extracted.push(...unparsed);
      return { parsed: false, extracted };
    }
  }
  return { parsed: parsedRoutines, extracted };
}

function shouldExtractFromSavedContent(savedText: string, details: unknown): boolean {
  if (!savedText) return false;
  try {
    const parsed: unknown = JSON.parse(savedText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (savedText.includes(OMITTED_AFTER_USE)) {
        try {
          return savedText === JSON.stringify(details);
        } catch {
          return false;
        }
      }
      return true;
    }
  } catch {
    if (savedText.includes(OMITTED_TEXT_BEFORE_USE) && !savedText.includes(OMITTED_AFTER_USE)) {
      try {
        const raw = JSON.stringify(details);
        if (raw) {
          const currentClip = clipToolResultText(raw);
          const structuredClip = clipToolResultText(
            shortenToolResultText(raw, TOOL_RESULT_TEXT_LIMIT),
          );
          return savedText !== currentClip && savedText !== structuredClip;
        }
      } catch {
        return true;
      }
    }
  }
  return false;
}

/** Extract watch-check outside text from a saved `schedule_list` or `task_catalog` toolResult. */
export function watchChecksFromToolResultMessage(
  message: {
    details?: unknown;
    content: unknown;
  },
  contextStrategy?: AgentContextStrategy,
): unknown[] {
  if (message.details && typeof message.details === "object" && "routines" in message.details) {
    const routines = (message.details as { routines?: unknown }).routines;
    if (Array.isArray(routines)) {
      const hasChecks = routines.some(
        (routine) =>
          routine &&
          typeof routine === "object" &&
          hasWatchOutsideContent((routine as { lastCheck?: unknown }).lastCheck),
      );
      if (!hasChecks) return [];
      const savedText = toolMessageTexts(message.content).join("\n");
      // For unshortened JSON and before-use cuts (`OMITTED_BEFORE_USE` / `OMITTED_TEXT_BEFORE_USE`),
      // extract only what remained in `content` so checkpoint recovery never attributes targets the
      // model did not receive. For after-use compaction (`OMITTED_AFTER_USE`) and Pi clips, recover
      // previously delivered watch evidence from `details`.
      if (shouldExtractFromSavedContent(savedText, message.details)) {
        return parseWatchChecksFromToolMessageContent(message.content).extracted;
      }
      const detected = savedToolResultStrategy(message, contextStrategy);
      if (detected === "verbatim") {
        return extractWatchCheckTexts(routines, MAX_OUTSIDE_TEXT_CHARS);
      }
      if (detected === "both") {
        const current = storedWatchCheckOutsideContent(routines, "current", {
          name: "schedule_list",
          payload: message.details,
        });
        const structured = storedWatchCheckOutsideContent(routines, DEFAULT_CONTEXT_STRATEGY, {
          name: "schedule_list",
          payload: message.details,
        });
        const seen = new Set<string>();
        return [...current, ...structured].filter((item) => {
          const key = typeof item === "string" ? item : JSON.stringify(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      return storedWatchCheckOutsideContent(routines, detected, {
        name: "schedule_list",
        payload: message.details,
      });
    }
  }
  return parseWatchChecksFromToolMessageContent(message.content).extracted;
}
