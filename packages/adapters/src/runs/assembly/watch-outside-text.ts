import type { AgentContextStrategy } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { sliceWellFormed } from "@rakazo/core";
import { shortenToolResultText } from "../../runtime/context/context-selection.js";
import {
  OMITTED_AFTER_USE,
  OMITTED_BEFORE_USE,
  OMITTED_TEXT_BEFORE_USE,
} from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";

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
  node: unknown,
  parts: WatchTextPart[],
  depth = 0,
  isEntryValue = false,
): void {
  if (depth > 16) return;
  if (typeof node === "string") {
    if (node.trim()) parts.push(isEntryValue ? { text: node, isEntryValue: true } : { text: node });
    return;
  }
  if (typeof node === "number") {
    parts.push({ text: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectRawWatchTextParts(item, parts, depth + 1, isEntryValue);
    return;
  }
  if (node && typeof node === "object") {
    if ((node as { type?: unknown }).type === "image") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "entries" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [entryKey, entryValue] of Object.entries(child)) {
          if (entryKey.trim()) parts.push({ text: entryKey });
          collectRawWatchTextParts(entryValue, parts, depth + 2, true);
        }
      } else {
        collectRawWatchTextParts(child, parts, depth + 1, isEntryValue);
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

function collectDecodedJsonStrings(value: unknown, parts: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value);
    return;
  }
  if (typeof value === "number") {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDecodedJsonStrings(item, parts, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.trim()) parts.push(key);
      collectDecodedJsonStrings(child, parts, depth + 1);
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
      if (Array.isArray(record.fields)) {
        for (const field of record.fields) {
          if (typeof field === "string") {
            try {
              collectDecodedJsonStrings(JSON.parse(field), decoded);
            } catch {
              if (field.trim()) decoded.push(field);
            }
          } else {
            collectDecodedJsonStrings(field, decoded);
          }
        }
      }
      if (record.title !== undefined && record.title !== null) {
        collectDecodedJsonStrings(record.title, decoded);
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

/**
 * Extract the outside content carried by stored routine watch checks (`lastCheck`), including
 * `entries` keys (which hold tracked item identities or file paths that `outsideTextOf` skips
 * when walking object values). Checks without `entries` or `detail` carry no outside text. Each
 * read keeps one representation matching the run's delivery strategy, bounded to Pi's raw UTF-16
 * delivery budget (`TOOL_RESULT_TEXT_LIMIT`) before NFKC normalization.
 */
export function storedWatchCheckOutsideContent(
  routines: readonly unknown[],
  contextStrategy?: AgentContextStrategy,
): unknown[] {
  const rawChecks: unknown[] = [];
  for (const routine of routines) {
    if (!routine || typeof routine !== "object") continue;
    const lastCheck = (routine as { lastCheck?: unknown }).lastCheck;
    if (hasWatchOutsideContent(lastCheck)) rawChecks.push(lastCheck);
  }
  if (rawChecks.length === 0) return [];
  const rawParts: WatchTextPart[] = [];
  collectRawWatchTextParts(rawChecks, rawParts);
  if (rawParts.length === 0) return rawChecks;
  const rawTotal = rawParts.reduce((sum, part) => sum + part.text.length, 0) + rawParts.length - 1;
  if (rawTotal <= TOOL_RESULT_TEXT_LIMIT) return formatBoundedWatchParts(rawParts, rawChecks);

  const strategy = contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
  if (strategy === "current") {
    return formatBoundedWatchParts(takePrefixPartList(rawParts, TOOL_RESULT_TEXT_LIMIT), rawChecks);
  }

  let shortenedParts: WatchTextPart[] | undefined;
  try {
    const rawJson = JSON.stringify(rawChecks);
    if (rawJson) {
      const shortenedJson = shortenToolResultText(rawJson, TOOL_RESULT_TEXT_LIMIT);
      const parsed: unknown = JSON.parse(shortenedJson);
      shortenedParts = [];
      collectRawWatchTextParts(parsed, shortenedParts);
    }
  } catch {
    shortenedParts = undefined;
  }
  return formatBoundedWatchParts(
    takePrefixPartList(shortenedParts ?? rawParts, TOOL_RESULT_TEXT_LIMIT),
    rawChecks,
  );
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

type SavedWatchStrategy = AgentContextStrategy | "both";

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
        const matchesCurrent = currentClip.startsWith(head) && currentClip.endsWith(tail);
        const matchesStructured = structuredClip.startsWith(head) && structuredClip.endsWith(tail);
        if (matchesCurrent && !matchesStructured) return "current";
        if (matchesStructured && !matchesCurrent) return DEFAULT_CONTEXT_STRATEGY;
      }
      return "both";
    }
  } catch {
    // Fall back to the resuming executor's strategy if details cannot be serialized.
  }
  return fallback;
}

function watchChecksFromToolMessageContent(
  content: unknown,
  contextStrategy?: AgentContextStrategy,
): unknown[] {
  const texts = toolMessageTexts(content);
  const extracted: unknown[] = [];
  const unparsed: string[] = [];
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "routines" in parsed) {
        const routines = (parsed as { routines?: unknown }).routines;
        if (Array.isArray(routines)) {
          extracted.push(...storedWatchCheckOutsideContent(routines, contextStrategy));
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
          extracted.push(...storedWatchCheckOutsideContent(routines, contextStrategy));
          return extracted;
        }
      }
      return extracted;
    } catch {
      // Truncated or non-JSON tool output cannot be narrowed safely, so keep its text.
      extracted.push(...unparsed);
    }
  }
  return extracted;
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
      const detected = savedToolResultStrategy(message, contextStrategy);
      if (detected === "both") {
        const current = storedWatchCheckOutsideContent(routines, "current");
        const structured = storedWatchCheckOutsideContent(routines, DEFAULT_CONTEXT_STRATEGY);
        const seen = new Set<string>();
        return [...current, ...structured].filter((item) => {
          const key = typeof item === "string" ? item : JSON.stringify(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      return storedWatchCheckOutsideContent(routines, detected);
    }
  }
  return watchChecksFromToolMessageContent(message.content, contextStrategy);
}
