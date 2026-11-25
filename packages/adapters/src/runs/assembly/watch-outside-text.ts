import type { AgentContextStrategy } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { sliceWellFormed } from "@rakazo/core";
import { MAX_OUTSIDE_TEXT_CHARS } from "../../approvals/review-target-sources.js";
import { shortenToolResultText } from "../../runtime/context/context-selection.js";
import {
  OMITTED_AFTER_USE,
  OMITTED_BEFORE_USE,
} from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import {
  deliveredToolResultText,
  serializeToolResult,
} from "../../runtime/pi/tools/pi-runtime-tools.js";
import type { WatchTextPart } from "./watch-outside-text-ranges.js";
import {
  collectRawWatchTextParts,
  extractDeliveredWatchPartsFromParsedJson,
  extractVisibleWatchPartsFromPlainTextBeforeUse,
  hasWatchOutsideContent,
  omissionMarkerIndex,
  unescapeJsonLayer,
  WATCH_ITEM_SIGNATURE,
} from "./watch-outside-text-ranges.js";

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
      kept.push(
        part.itemSlice
          ? { text: sliced, itemSlice: part.itemSlice }
          : part.isEntryValue
            ? { text: sliced, isEntryValue: true }
            : { text: sliced },
      );
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
  if (part.itemSlice === "title") return unescapeJsonLayer(part.text);
  if (part.itemSlice === "fields") return unescapeClippedWatchItem(part.text);
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
    const parts = extractDeliveredWatchPartsFromParsedJson(unclipped, [
      { start: 0, end: TOOL_RESULT_TEXT_LIMIT },
    ]);
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
      extracted.push(...unparsed);
      return { parsed: false, extracted };
    }
  }
  return { parsed: parsedRoutines, extracted };
}

function dedupeItems(items: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findMinTighterBeforeUseLeafLength(saved: unknown, delivered: unknown): number | undefined {
  let minLen: number | undefined;
  const stack: Array<{ saved: unknown; delivered: unknown }> = [{ saved, delivered }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item.saved === "string" && typeof item.delivered === "string") {
      if (
        item.saved.includes(OMITTED_BEFORE_USE) &&
        (!item.delivered.includes(OMITTED_BEFORE_USE) || item.saved.length < item.delivered.length)
      ) {
        minLen =
          minLen === undefined ? item.delivered.length : Math.min(minLen, item.delivered.length);
      }
      continue;
    }
    if (Array.isArray(item.saved) && Array.isArray(item.delivered)) {
      const len = Math.min(item.saved.length, item.delivered.length);
      for (let i = 0; i < len; i += 1) {
        stack.push({ saved: item.saved[i], delivered: item.delivered[i] });
      }
      continue;
    }
    if (
      item.saved &&
      typeof item.saved === "object" &&
      !Array.isArray(item.saved) &&
      item.delivered &&
      typeof item.delivered === "object" &&
      !Array.isArray(item.delivered)
    ) {
      const deliveredRec = item.delivered as Record<string, unknown>;
      for (const [key, value] of Object.entries(item.saved as Record<string, unknown>)) {
        if (Object.hasOwn(deliveredRec, key)) {
          stack.push({ saved: value, delivered: deliveredRec[key] });
        }
      }
    }
  }
  return minLen;
}

function mergeAfterUseWatchValue(
  saved: unknown,
  delivered: unknown,
  minTighterBeforeUseLen: number | undefined,
): unknown {
  if (typeof saved === "string") {
    if (
      saved.includes(OMITTED_AFTER_USE) &&
      typeof delivered === "string" &&
      !delivered.includes(OMITTED_AFTER_USE) &&
      !(saved.includes(OMITTED_BEFORE_USE) && !delivered.includes(OMITTED_BEFORE_USE)) &&
      (minTighterBeforeUseLen === undefined || delivered.length < minTighterBeforeUseLen)
    ) {
      return delivered;
    }
    return saved;
  }
  if (Array.isArray(saved) && Array.isArray(delivered)) {
    return saved.map((entry, index) =>
      mergeAfterUseWatchValue(entry, delivered[index], minTighterBeforeUseLen),
    );
  }
  if (
    saved &&
    typeof saved === "object" &&
    !Array.isArray(saved) &&
    delivered &&
    typeof delivered === "object" &&
    !Array.isArray(delivered)
  ) {
    const deliveredRec = delivered as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
      merged[key] = Object.hasOwn(deliveredRec, key)
        ? mergeAfterUseWatchValue(value, deliveredRec[key], minTighterBeforeUseLen)
        : value;
    }
    return merged;
  }
  return saved;
}

function mergeAfterUseWatchRoutines(
  savedPayload: Record<string, unknown>,
  deliveredPayload: Record<string, unknown>,
): unknown[] | undefined {
  const savedRoutines = savedPayload.routines;
  const deliveredRoutines = deliveredPayload.routines;
  if (!Array.isArray(savedRoutines) || !Array.isArray(deliveredRoutines)) return undefined;
  const minTighterBeforeUseLen = findMinTighterBeforeUseLeafLength(savedPayload, deliveredPayload);
  const byId = new Map<string, unknown>();
  for (const routine of deliveredRoutines) {
    if (routine && typeof routine === "object") {
      const id = (routine as { routineId?: unknown }).routineId;
      if (typeof id === "string" && id) byId.set(id, routine);
    }
  }
  return savedRoutines.map((routine, index) => {
    if (!routine || typeof routine !== "object") return routine;
    const savedRec = routine as Record<string, unknown>;
    const id = typeof savedRec.routineId === "string" ? savedRec.routineId : undefined;
    const match = (id ? byId.get(id) : undefined) ?? deliveredRoutines[index];
    if (!match || typeof match !== "object") return routine;
    const matchRec = match as Record<string, unknown>;
    if (!("lastCheck" in savedRec) || !("lastCheck" in matchRec)) return routine;
    return {
      ...savedRec,
      lastCheck: mergeAfterUseWatchValue(
        savedRec.lastCheck,
        matchRec.lastCheck,
        minTighterBeforeUseLen,
      ),
    };
  });
}

function formatPlainTextBeforeUseGroups(partGroups: readonly WatchTextPart[][]): unknown[] {
  const extracted: unknown[] = [];
  for (const parts of partGroups) {
    extracted.push(
      ...formatBoundedWatchParts(takePrefixPartList(parts, MAX_OUTSIDE_TEXT_CHARS), []),
    );
  }
  return dedupeItems(extracted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractVisibleWatchChecksFromDeliveredText(
  deliveredText: string,
  cleanDetails: Record<string, unknown>,
  allowAfterUseOnly: boolean,
): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(deliveredText);
    if (isRecord(parsed)) {
      return parseWatchChecksFromToolMessageContent([{ type: "text", text: deliveredText }])
        .extracted;
    }
  } catch {
    // Plain-text cut; fall through to visible-fragment decoding.
  }
  const partGroups = extractVisibleWatchPartsFromPlainTextBeforeUse(deliveredText, cleanDetails, {
    allowAfterUseOnly,
  });
  if (partGroups !== undefined) return formatPlainTextBeforeUseGroups(partGroups);
  // A previously accepted full delivery clipped at TOOL_RESULT_TEXT_LIMIT is non-JSON without
  // a context omission marker; decode its exact clipped watch checks directly.
  const routines = Array.isArray(cleanDetails.routines) ? cleanDetails.routines : undefined;
  if (routines) {
    try {
      const raw = JSON.stringify(cleanDetails);
      if (raw.length > TOOL_RESULT_TEXT_LIMIT) {
        if (deliveredText === clipToolResultText(raw)) {
          return storedWatchCheckOutsideContent(routines, "current", {
            name: "schedule_list",
            payload: cleanDetails,
          });
        }
        if (
          deliveredText === clipToolResultText(shortenToolResultText(raw, TOOL_RESULT_TEXT_LIMIT))
        ) {
          return storedWatchCheckOutsideContent(routines, DEFAULT_CONTEXT_STRATEGY, {
            name: "schedule_list",
            payload: cleanDetails,
          });
        }
      }
    } catch {
      // Fall through when cleanDetails cannot be serialized.
    }
  }
  return undefined;
}

/** Extract watch-check outside text from a saved `schedule_list` or `task_catalog` toolResult. */
export function watchChecksFromToolResultMessage(
  message: {
    details?: unknown;
    content: unknown;
  },
  contextStrategy?: AgentContextStrategy,
): unknown[] {
  const detailsObj = isRecord(message.details) ? message.details : undefined;
  if (detailsObj && "routines" in detailsObj) {
    const routines = detailsObj.routines;
    if (Array.isArray(routines)) {
      const hasChecks = routines.some(
        (routine) =>
          routine &&
          typeof routine === "object" &&
          hasWatchOutsideContent((routine as { lastCheck?: unknown }).lastCheck),
      );
      if (!hasChecks) return [];
      const savedText = toolMessageTexts(message.content).join("\n");
      // If `selectContext` shortened the result before first use, preserve that exact first
      // delivery (plus any additional visible text from later accepted deliveries) across
      // after-use compaction without restoring omitted regions from raw `details`.
      if (typeof detailsObj.contextBeforeUseText === "string") {
        const {
          contextBeforeUseText,
          contextDeliveredTexts: rawDeliveredTexts,
          ...cleanDetails
        } = detailsObj;
        const collected: unknown[] = [];
        let matchedAny = false;
        const firstExtracted = extractVisibleWatchChecksFromDeliveredText(
          contextBeforeUseText,
          cleanDetails,
          false,
        );
        if (firstExtracted !== undefined) {
          matchedAny = true;
          collected.push(...firstExtracted);
        }
        const extraTexts = new Set<string>();
        if (Array.isArray(rawDeliveredTexts)) {
          for (const entry of rawDeliveredTexts) {
            if (typeof entry === "string" && entry && entry !== contextBeforeUseText) {
              extraTexts.add(entry);
            }
          }
        }
        if (savedText && savedText !== contextBeforeUseText) {
          extraTexts.add(savedText);
        }
        for (const extraText of extraTexts) {
          const extraExtracted = extractVisibleWatchChecksFromDeliveredText(
            extraText,
            cleanDetails,
            true,
          );
          if (extraExtracted !== undefined) {
            matchedAny = true;
            collected.push(...extraExtracted);
          }
        }
        if (matchedAny) return dedupeItems(collected);
      }
      if (savedText) {
        try {
          const parsedSaved: unknown = JSON.parse(savedText);
          if (parsedSaved && typeof parsedSaved === "object" && !Array.isArray(parsedSaved)) {
            if (!savedText.includes(OMITTED_AFTER_USE)) {
              return parseWatchChecksFromToolMessageContent(message.content).extracted;
            }
            const raw = JSON.stringify(detailsObj);
            if (savedText === raw) {
              return parseWatchChecksFromToolMessageContent(message.content).extracted;
            }
            const detected = savedToolResultStrategy(message, contextStrategy);
            const deliveredPayloads: Array<Record<string, unknown>> = [];
            if (raw.length <= TOOL_RESULT_TEXT_LIMIT || detected === "verbatim") {
              deliveredPayloads.push(detailsObj);
            } else {
              const strategies: AgentContextStrategy[] =
                detected === "both"
                  ? ["current", DEFAULT_CONTEXT_STRATEGY]
                  : [detected ?? DEFAULT_CONTEXT_STRATEGY];
              for (const strategy of strategies) {
                try {
                  const deliveredText = deliveredToolResultText(
                    detailsObj,
                    strategy,
                    "schedule_list",
                    {},
                  );
                  const parsedDelivered: unknown = JSON.parse(deliveredText);
                  if (
                    parsedDelivered &&
                    typeof parsedDelivered === "object" &&
                    !Array.isArray(parsedDelivered)
                  ) {
                    deliveredPayloads.push(parsedDelivered as Record<string, unknown>);
                  }
                } catch {
                  // Delivered text was clipped non-JSON; structured merge does not apply.
                }
              }
            }
            if (deliveredPayloads.length > 0) {
              const mergedResults: unknown[] = [];
              for (const deliveredPayload of deliveredPayloads) {
                const mergedRoutines = mergeAfterUseWatchRoutines(
                  parsedSaved as Record<string, unknown>,
                  deliveredPayload,
                );
                if (mergedRoutines) {
                  mergedResults.push(
                    ...extractWatchCheckTexts(mergedRoutines, MAX_OUTSIDE_TEXT_CHARS),
                  );
                }
              }
              if (mergedResults.length > 0) return dedupeItems(mergedResults);
            }
          }
        } catch {
          const partGroups = extractVisibleWatchPartsFromPlainTextBeforeUse(savedText, detailsObj);
          if (partGroups !== undefined) return formatPlainTextBeforeUseGroups(partGroups);
        }
      }
      const detected = savedToolResultStrategy(message, contextStrategy);
      if (detected === "verbatim") {
        return extractWatchCheckTexts(routines, MAX_OUTSIDE_TEXT_CHARS);
      }
      if (detected === "both") {
        const current = storedWatchCheckOutsideContent(routines, "current", {
          name: "schedule_list",
          payload: detailsObj,
        });
        const structured = storedWatchCheckOutsideContent(routines, DEFAULT_CONTEXT_STRATEGY, {
          name: "schedule_list",
          payload: detailsObj,
        });
        return dedupeItems([...current, ...structured]);
      }
      return storedWatchCheckOutsideContent(routines, detected, {
        name: "schedule_list",
        payload: detailsObj,
      });
    }
  }
  return parseWatchChecksFromToolMessageContent(message.content).extracted;
}
