import type { AgentRunRequest, AgentToolCompletion } from "@rakazo/adapter-kit";
import type { ToolStepCall } from "@rakazo/contracts";
import { storedImageMimeType } from "@rakazo/contracts";
import {
  createSecretMatcher,
  escapePromptData,
  redactJsonStringsAndPlainText,
  redactSecrets,
  sliceWellFormed,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { redactToolArgsForReview } from "../../approvals/auto-review.js";
import { sanitizeConnectorError } from "../../integrations/connector-safety.js";
import { PICTURE_READING_TOOLS } from "../../media/tool-result-image.js";
import { READ_MEETING_TRANSCRIPT } from "../../meetings/meeting-chat.tool-definition.js";
import { sanitizeSensitiveText } from "../../runtime/pi/pi-runtime-errors.js";
import {
  mapTurnTranscript,
  turnTranscriptResults,
} from "../../runtime/pi/pi-runtime-transcript.js";
import { storeStepScreenshot } from "../../storage/thread-artifacts.js";
import type { ReplyState, RunContext } from "../assembly/run-context.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";

/**
 * The most of one call's result, or of any one text in its arguments, kept for later turns. The
 * bound is applied once, when the reply is saved, so the replay of a reply never changes.
 */
export const TOOL_CALL_TEXT_MAX_CHARS = 1_000;
/** The most of all results one reply keeps; later results get what is left, then none. */
export const TOOL_REPLY_RESULTS_MAX_CHARS = 8_000;
const TOOL_RESULT_MIN_CHARS = 200;
/** Lists and nesting in arguments are kept generously; only pathological shapes are bounded. */
const ARGUMENT_ITEMS_MAX = 100;
const ARGUMENT_DEPTH_MAX = 8;

/** Stands in for an image a call returned; replay says what the bot wrote after seeing it. */
export const IMAGE_NOT_KEPT = "[image not kept]";

const notKept = (chars: number) => `\n… [${chars} characters not kept] …\n`;
const OMISSION_MARKER_PREFIX = "\n… [";
const OMISSION_MARKER_SUFFIX = " characters not kept] …\n";
/** A saved count fits in this many digits; a longer run is not the omission marker. */
const OMISSION_MARKER_MAX_DIGITS = 16;

/**
 * End index of an omission marker starting at `index`, or -1. The check is a fixed prefix, a
 * bounded digit run, and a fixed suffix, so it stays linear.
 */
function omissionMarkerEnd(text: string, index: number): number {
  if (!text.startsWith(OMISSION_MARKER_PREFIX, index)) return -1;
  let pos = index + OMISSION_MARKER_PREFIX.length;
  const digitStart = pos;
  const digitLimit = Math.min(text.length, pos + OMISSION_MARKER_MAX_DIGITS);
  while (pos < digitLimit) {
    const code = text.charCodeAt(pos);
    if (code < 48 || code > 57) break;
    pos += 1;
  }
  if (pos === digitStart || !text.startsWith(OMISSION_MARKER_SUFFIX, pos)) return -1;
  return pos + OMISSION_MARKER_SUFFIX.length;
}

/** The largest a saved result gets: its kept text and the note of what was left out. */
export const TOOL_CALL_SAVED_TEXT_MAX_CHARS =
  TOOL_CALL_TEXT_MAX_CHARS + notKept(Number.MAX_SAFE_INTEGER).length;

/** Keyword match inside an ASCII identifier key (`[\w-]+`). */
const CREDENTIAL_KEY_NAME =
  /(?:api[_-]?key|token|password|passwd|secret|authorization|credential)/i;

function isCredentialKeyChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 45
  );
}

/**
 * True when `lineStart` opens a new JSON property line (e.g. `  "token":` or `}, "token":`).
 * Inspects only the current line, so calling it once per physical newline keeps scanning linear.
 */
function isJsonPropertyLineStart(text: string, lineStart: number): boolean {
  let pos = lineStart;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === " " || ch === "\t" || ch === "}" || ch === "]" || ch === "," || ch === "{") {
      pos += 1;
      continue;
    }
    break;
  }
  if (pos >= text.length || text[pos] !== '"') return false;
  let keyEnd = pos + 1;
  while (keyEnd < text.length) {
    const ch = text[keyEnd]!;
    if (ch === '"') break;
    if (ch === "\n" || ch === "\r") return false;
    if (ch === "\\") {
      if (keyEnd + 1 >= text.length || text[keyEnd + 1] === "\n" || text[keyEnd + 1] === "\r") {
        return false;
      }
      keyEnd += 2;
      continue;
    }
    keyEnd += 1;
  }
  if (keyEnd >= text.length || text[keyEnd] !== '"') return false;
  let colonPos = keyEnd + 1;
  while (
    colonPos < text.length &&
    (text[colonPos] === " " ||
      text[colonPos] === "\t" ||
      text[colonPos] === "\r" ||
      text[colonPos] === "\n")
  ) {
    colonPos += 1;
  }
  return colonPos < text.length && text[colonPos] === ":";
}

type JsonStringEnd = {
  end: number;
  fragmentEnd: number;
  nextIndex: number;
  /** True when [fragmentEnd, nextIndex) is an omission marker kept out of the value. */
  omission: boolean;
};

/**
 * Index of the `\n` that may open an omission marker at this break. A `\r\n` break checks the
 * marker at the line feed.
 */
function omissionMarkerBreak(text: string, index: number): number {
  if (text[index] === "\n") return index;
  if (text[index] === "\r" && text[index + 1] === "\n") return index + 1;
  return -1;
}

function markerBoundary(text: string, index: number): JsonStringEnd | undefined {
  const markerAt = omissionMarkerBreak(text, index);
  if (markerAt < 0) return undefined;
  const markerEnd = omissionMarkerEnd(text, markerAt);
  if (markerEnd < 0) return undefined;
  return { end: -1, fragmentEnd: markerAt, nextIndex: markerEnd, omission: true };
}

function scanJsonStringEnd(
  text: string,
  openQuote: number,
  honorOmissionMarker: boolean,
): JsonStringEnd {
  for (let index = openQuote + 1; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "\n" || ch === "\r") {
      if (honorOmissionMarker) {
        const marker = markerBoundary(text, index);
        if (marker) return marker;
      }
      const nextLineStart = ch === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
      if (isJsonPropertyLineStart(text, nextLineStart)) {
        return { end: -1, fragmentEnd: index, nextIndex: nextLineStart, omission: false };
      }
      if (nextLineStart > index + 1) index += 1;
      continue;
    }
    if (ch === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        return { end: -1, fragmentEnd: text.length, nextIndex: text.length, omission: false };
      }
      if (next === "\n" || next === "\r") {
        if (honorOmissionMarker) {
          const marker = markerBoundary(text, index + 1);
          if (marker) return marker;
        }
        const nextLineStart = next === "\r" && text[index + 2] === "\n" ? index + 3 : index + 2;
        if (isJsonPropertyLineStart(text, nextLineStart)) {
          return { end: -1, fragmentEnd: index + 1, nextIndex: nextLineStart, omission: false };
        }
        index = nextLineStart - 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      return { end: index, fragmentEnd: index + 1, nextIndex: index + 1, omission: false };
    }
  }
  return { end: -1, fragmentEnd: text.length, nextIndex: text.length, omission: false };
}

const REDACTED_PLACEHOLDER = "[redacted]";

function skipJsonSpace(text: string, index: number): number {
  while (index < text.length) {
    const ch = text[index]!;
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
    index += 1;
  }
  return index;
}

/** Length of one JSON string escape at the backslash, or 0 when the escape is incomplete. */
function jsonEscapeLength(text: string, index: number): number {
  const next = text[index + 1];
  if (
    next === '"' ||
    next === "\\" ||
    next === "/" ||
    next === "b" ||
    next === "f" ||
    next === "n" ||
    next === "r" ||
    next === "t"
  ) {
    return 2;
  }
  if (next !== "u") return 0;
  for (let hex = 0; hex < 4; hex += 1) {
    const code = text.charCodeAt(index + 2 + hex);
    const digit =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (!digit) return 0;
  }
  return 6;
}

/** Index just after the JSON string that opens at `index`, or -1. A raw newline ends it. */
function jsonStringEnd(text: string, index: number): number {
  if (text[index] !== '"') return -1;
  let end = index + 1;
  while (end < text.length) {
    const ch = text[end]!;
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      const size = jsonEscapeLength(text, end);
      if (size === 0) return -1;
      end += size;
      continue;
    }
    if (ch === '"') return end + 1;
    end += 1;
  }
  return -1;
}

/** True when `index` is the opening quote of a JSON key followed by `:`. */
function keyColonAt(text: string, index: number): boolean {
  const afterKey = jsonStringEnd(text, index);
  if (afterKey < 0) return false;
  return text[skipJsonSpace(text, afterKey)] === ":";
}

/** Whitespace, a comma, or a container close. A `:` is not a value delimiter. */
function jsonDelimiter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index]!;
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "," ||
    ch === "}" ||
    ch === "]"
  );
}

/**
 * Index just after a JSON number at `index`, or -1. A bare `-`, a leading zero, a trailing dot,
 * or an exponent with no digits is not a number. The scan never steps backward.
 */
function jsonNumberEnd(text: string, index: number): number {
  let pos = index;
  if (text[pos] === "-") pos += 1;
  const first = text[pos];
  if (first === "0") {
    pos += 1;
  } else if (first !== undefined && first >= "1" && first <= "9") {
    pos += 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  } else {
    return -1;
  }
  if (text[pos] === ".") {
    const frac = pos + 1;
    if (frac >= text.length || text[frac]! < "0" || text[frac]! > "9") return -1;
    pos = frac + 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  }
  if (text[pos] === "e" || text[pos] === "E") {
    let exp = pos + 1;
    if (text[exp] === "+" || text[exp] === "-") exp += 1;
    if (exp >= text.length || text[exp]! < "0" || text[exp]! > "9") return -1;
    pos = exp + 1;
    while (pos < text.length && text[pos]! >= "0" && text[pos]! <= "9") pos += 1;
  }
  return pos;
}

function jsonValueStarts(text: string, index: number): boolean {
  const at = skipJsonSpace(text, index);
  if (at >= text.length) return false;
  const ch = text[at]!;
  if (ch === '"' || ch === "{" || ch === "[") return true;
  if (text.startsWith("true", at) && jsonDelimiter(text, at + 4)) return true;
  if (text.startsWith("false", at) && jsonDelimiter(text, at + 5)) return true;
  if (text.startsWith("null", at) && jsonDelimiter(text, at + 4)) return true;
  const end = jsonNumberEnd(text, at);
  return end > at && jsonDelimiter(text, end);
}

/**
 * A `"` ends a credential when the containers close or another field starts after it.
 * `}` and `]` may nest (`}]`), with space between them. A comma counts only with a quoted key,
 * a colon, and a real JSON value, or with another closer. A bare `]` with no quote does not.
 */
function authenticAfterQuote(text: string, quote: number): boolean {
  let index = skipJsonSpace(text, quote + 1);
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "}" || ch === "]") {
      index = skipJsonSpace(text, index + 1);
      if (index >= text.length) return true;
      continue;
    }
    if (ch !== ",") return false;
    const at = skipJsonSpace(text, index + 1);
    if (at >= text.length) return false;
    if (text[at] === "}" || text[at] === "]") {
      index = at;
      continue;
    }
    if (!keyColonAt(text, at)) return false;
    const keyEnd = jsonStringEnd(text, at);
    const colon = skipJsonSpace(text, keyEnd);
    return text[colon] === ":" && jsonValueStarts(text, colon + 1);
  }
  return true;
}

/** Value text between the opening quote and the marker, ignoring one trailing carriage return. */
function credentialHeadValue(text: string, openQuote: number, markerAt: number): string {
  let end = markerAt;
  if (text[end - 1] === "\r" && end - 1 > openQuote) end -= 1;
  return text.slice(openQuote + 1, end);
}

/**
 * Index of the closing quote when the head and tail are the two halves of `[redacted]"`, or -1.
 * Rewriting that placeholder would grow the saved text.
 */
function redactedSplitQuote(headValue: string, tail: string): number {
  if (headValue.length === 0 || !REDACTED_PLACEHOLDER.startsWith(headValue)) return -1;
  const rest = REDACTED_PLACEHOLDER.slice(headValue.length);
  if (!tail.startsWith(rest) || tail[rest.length] !== '"') return -1;
  return authenticAfterQuote(tail, rest.length) ? rest.length : -1;
}

/**
 * Index of a quote that really ends the credential. A `"` whose escaping backslash was cut off
 * is followed by more of the value, so it does not count.
 */
function confirmedCredentialClose(tail: string): number {
  for (let index = 0; index < tail.length; index += 1) {
    const ch = tail[index]!;
    if (ch === "\\") {
      if (index + 1 >= tail.length) return -1;
      index += 1;
      continue;
    }
    if (ch === '"' && authenticAfterQuote(tail, index)) return index;
  }
  return -1;
}

/**
 * The credential closed inside the omitted span. The tail is the next JSON field, a brace, or a
 * short non-secret lead into that field. It is not the rest of the credential.
 */
function structuralLeadEnd(tail: string): number {
  let index = 0;
  while (index < tail.length) {
    const lead = tail[index]!;
    if (
      lead !== " " &&
      lead !== "\t" &&
      lead !== "\n" &&
      lead !== "\r" &&
      lead !== "…" &&
      lead !== "."
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

/**
 * True when `index` opens `]` / `}` closers and the next thing is a comma plus a real JSON field.
 * A bare `]` or a `]` with raw text after it is still the credential.
 */
function closersThenField(text: string, index: number): boolean {
  let at = index;
  if (text[at] !== "]" && text[at] !== "}") return false;
  while (at < text.length && (text[at] === "]" || text[at] === "}")) {
    at = skipJsonSpace(text, at + 1);
  }
  if (at >= text.length || text[at] !== ",") return false;
  const key = skipJsonSpace(text, at + 1);
  if (!keyColonAt(text, key)) return false;
  const keyEnd = jsonStringEnd(text, key);
  const colon = skipJsonSpace(text, keyEnd);
  return text[colon] === ":" && jsonValueStarts(text, colon + 1);
}

function isStructuralContinuation(tail: string): boolean {
  const start = structuralLeadEnd(tail);
  if (start >= tail.length) return true;
  const ch = tail[start]!;
  if (ch === '"') {
    if (authenticAfterQuote(tail, start)) return true;
    if (!keyColonAt(tail, start)) return false;
    const keyEnd = jsonStringEnd(tail, start);
    const colon = skipJsonSpace(tail, keyEnd);
    return tail[colon] === ":" && jsonValueStarts(tail, colon + 1);
  }
  if (ch === "," || ch === "}") return authenticAfterQuote(tail, start - 1);
  if (ch === "]") return closersThenField(tail, start);
  return false;
}

/** Linear-time replacement for JSON fields whose key name indicates a credential string value. */
function redactCredentialJsonFields(text: string, honorOmissionMarker: boolean): string {
  if (!text.includes('"')) return text;
  let cursor = 0;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const openKey = text.indexOf('"', index);
    if (openKey < 0) break;
    let pos = openKey + 1;
    while (pos < text.length && isCredentialKeyChar(text[pos]!)) pos += 1;
    if (pos >= text.length) break;
    if (text[pos] !== '"') {
      index = pos;
      continue;
    }
    const closeKey = pos;
    const keyName = text.slice(openKey + 1, closeKey);
    if (!CREDENTIAL_KEY_NAME.test(keyName)) {
      index = closeKey;
      continue;
    }
    pos = closeKey + 1;
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
    if (text[pos] !== ":") {
      index = pos;
      continue;
    }
    pos += 1;
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
    if (text[pos] !== '"') {
      index = pos;
      continue;
    }
    const scanned = scanJsonStringEnd(text, pos, honorOmissionMarker);
    // A saved cut can split one credential around a real omission marker. Keep the marker.
    // An already-redacted placeholder stays as saved. A later JSON field stays too. An unclosed
    // legacy value is redacted through its end, including a quote whose escape was cut off.
    if (scanned.omission) {
      const headValue = credentialHeadValue(text, pos, scanned.fragmentEnd);
      const tail = text.slice(scanned.nextIndex);
      const splitQuote = redactedSplitQuote(headValue, tail);
      // `[r` + `edacted]"` is the saved placeholder, and nothing raw sits inside that value.
      if (splitQuote >= 0) {
        index = scanned.nextIndex + splitQuote + 1;
        continue;
      }
      const marker = text.slice(scanned.fragmentEnd, scanned.nextIndex);
      if (isStructuralContinuation(tail)) {
        out += `${text.slice(cursor, pos)}"[redacted]"${marker}`;
        cursor = scanned.nextIndex;
        index = scanned.nextIndex;
        continue;
      }
      const close = confirmedCredentialClose(tail);
      out += `${text.slice(cursor, pos)}"[redacted]"${marker}[redacted]`;
      cursor = close >= 0 ? scanned.nextIndex + close : text.length;
      index = cursor;
      continue;
    }
    out += `${text.slice(cursor, pos)}"[redacted]"`;
    cursor = scanned.fragmentEnd;
    index = scanned.nextIndex;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

function cleanToolText(text: string, secrets: string[], honorOmissionMarker = false): string {
  const secretForms = secrets.flatMap((value) => {
    if (!value) return [];
    const encoded = JSON.stringify(value).slice(1, -1);
    return [value, encoded, encoded.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")];
  });
  const sanitizeDecoded = (value: string) => sanitizeSensitiveText(redactSecrets(value, secrets));
  const sanitizePlain = (value: string) => sanitizeSensitiveText(redactSecrets(value, secretForms));
  const cleaned = redactJsonStringsAndPlainText(text, sanitizeDecoded, sanitizePlain, secrets);
  return redactCredentialJsonFields(cleaned, honorOmissionMarker);
}

function sliceTailWellFormed(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start);
    const prev = text.charCodeAt(start - 1);
    if (code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
      start += 1;
    }
  }
  return text.slice(start);
}

/** Spans of omission markers. Each character is visited once and each check is bounded. */
function omissionSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\n") {
      index += 1;
      continue;
    }
    const end = omissionMarkerEnd(text, index);
    if (end < 0) {
      index += 1;
      continue;
    }
    spans.push([index, end]);
    // The trailing newline can open the next marker. It is strictly after this marker's start.
    const shared = end - 1;
    index = shared > index ? shared : index + 1;
  }
  return spans;
}

function truncateBounded(cleaned: string, max: number, preserveMarkers = false): string {
  if (cleaned.length <= max) return cleaned;
  const headLength = Math.floor(max * 0.7);
  const tailLength = max - headLength;
  if (!preserveMarkers) {
    const head = sliceWellFormed(cleaned, headLength);
    const tail = sliceTailWellFormed(cleaned, tailLength);
    const omitted = cleaned.length - head.length - tail.length;
    if (omitted <= 0) return cleaned;
    return `${head}${notKept(omitted)}${tail}`;
  }
  // Replay stays within max, including the new note. A cut inside a marker moves once, against
  // the original cut: the head pulls back to the marker start and the tail pushes forward to the
  // marker's trailing newline. A chain of markers that share that newline cannot walk the cut
  // forward, so the kept text shrinks and a later marker stays whole.
  const noteRoom = notKept(Number.MAX_SAFE_INTEGER).length;
  const budget = Math.max(0, max - noteRoom);
  const headCut = Math.min(Math.floor(budget * 0.7), cleaned.length);
  const tailCut = Math.max(cleaned.length - (budget - headCut), 0);
  const spans = omissionSpans(cleaned);
  let headEnd = headCut;
  let tailStart = tailCut;
  for (const [start, end] of spans) {
    if (headCut > start && headCut < end) headEnd = start;
    if (tailCut > start && tailCut < end) tailStart = end - 1;
  }
  if (tailStart < headEnd) tailStart = headEnd;
  const head = sliceWellFormed(cleaned, headEnd);
  let from = tailStart;
  if (from > 0 && from < cleaned.length) {
    const code = cleaned.charCodeAt(from);
    const prev = cleaned.charCodeAt(from - 1);
    if (code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
      from += 1;
      for (const [start, end] of spans) {
        if (from > start && from < end) {
          from = end - 1;
          break;
        }
      }
    }
  }
  if (from < head.length) from = head.length;
  const tail = cleaned.slice(from);
  const omitted = cleaned.length - head.length - tail.length;
  if (omitted <= 0) {
    let end = Math.min(max, cleaned.length);
    for (const [start, markerEnd] of spans) {
      if (end > start && end < markerEnd) end = start;
    }
    return sliceWellFormed(cleaned, end);
  }
  return `${head}${notKept(omitted)}${tail}`;
}

/**
 * Text bounded to `max` characters, keeping its start and end (where a command's output usually
 * ends with what matters) and saying how much was left out, so it never reads as unfinished.
 * Secrets are redacted before slicing, so a value cut at the edge is still caught.
 * `replaySaved` is only for text already saved: it may keep a real omission marker and still
 * redact a credential that marker split. Fresh tool output never treats that line as a cut.
 */
export function bounded(
  text: string,
  max: number,
  secrets: string[] = [],
  options?: { replaySaved?: boolean },
): string {
  return truncateBounded(
    cleanToolText(text, secrets, options?.replaySaved === true),
    max,
    options?.replaySaved === true,
  );
}

function keptArgument(value: unknown, depth: number, secrets: string[]): unknown {
  if (typeof value === "string") return bounded(value, TOOL_CALL_TEXT_MAX_CHARS, secrets);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= ARGUMENT_DEPTH_MAX) return "[nested too deep to keep]";
  if (Array.isArray(value))
    return value.slice(0, ARGUMENT_ITEMS_MAX).map((item) => keptArgument(item, depth + 1, secrets));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, ARGUMENT_ITEMS_MAX)
        .map(([key, item]) => [key, keptArgument(item, depth + 1, secrets)]),
    );
  return undefined;
}

/**
 * A call's arguments as the model sent them, for later turns to replay: the run's secrets and
 * credential-like keys redacted as for an approval review, and only very long texts bounded.
 */
export function keptToolArguments(args: unknown, secrets: string[]): ToolStepCall["arguments"] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "{}";
  return JSON.stringify(
    keptArgument(redactToolArgsForReview(args as Record<string, unknown>, secrets), 0, secrets),
  );
}

/** Tools whose results carry secret values or their names are not kept. */
const SECRET_TOOL = /secret/i;

/** What the model read back from a call (or its error), redacted and bounded to `max`. */
export function keptToolResult(
  completion: AgentToolCompletion,
  secrets: string[],
  max = TOOL_CALL_TEXT_MAX_CHARS,
): string | undefined {
  // Re-read meeting transcripts through their access policy, including after deletion.
  if (
    completion.paused ||
    SECRET_TOOL.test(completion.name) ||
    completion.name === READ_MEETING_TRANSCRIPT
  )
    return undefined;
  let text: string;
  if (completion.error !== undefined) {
    text = sanitizeConnectorError(completion.error, secrets, {
      maxChars: Number.POSITIVE_INFINITY,
    });
  } else {
    const content = (completion.result as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return undefined;
    text = content
      .map((part: { type?: unknown; text?: unknown }) =>
        part?.type === "text" && typeof part.text === "string"
          ? part.text
          : part?.type === "image"
            ? IMAGE_NOT_KEPT
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (!text.trim()) return undefined;
  const cleaned = cleanToolText(text, secrets).trim();
  const limit = completion.error !== undefined ? Math.min(max, 2_000) : max;
  return cleaned ? truncateBounded(cleaned, limit) : undefined;
}

/**
 * Whether a run may replay what this bot's earlier replies' tools were sent and returned. Only a
 * run the owner started themselves, directly in their own chat or with their own team-chat
 * message, gets them. Every other run (other bots, connected agents, channels, schedules,
 * webhooks, other members, guests, and any trigger added later) sees those replies as everyone
 * did, so tool output never reaches someone it wasn't for.
 */
export function runReplaysToolHistory(
  trigger: string,
  source: { fromUser: boolean; nonOwnerChat: boolean },
): boolean {
  if (source.nonOwnerChat) return false;
  switch (trigger) {
    case "user":
    case "call_end":
      return true;
    case "follow_up":
      return source.fromUser;
    case "messaging":
      // Only the owner's own message: a channel or another person is nonOwnerChat above.
      return true;
    // A run resumed after its question or a takeover is the same run, keeping its own trigger and
    // source, so it inherits the original's answer here. A run recorded as "resume" names no
    // original run to trace, so it is refused with every other trigger.
    default:
      return false;
  }
}

const REPLY_TARGET_TAGS = [
  { open: "<reply_target>", close: "</reply_target>" },
  { open: "<reaction_target>", close: "</reaction_target>" },
] as const;

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

/**
 * Redact known secrets in a stored turn's prompt, decoding JSON strings inside `<reply_target>` /
 * `<reaction_target>` blocks while preserving their `\u003c`/`\u003e` framing, and matching
 * XML-escaped secrets in recalled memory or framed prompt sections.
 */
function redactStoredPrompt(text: string, secrets: string[]): string {
  if (secrets.length === 0 || !text) return text;
  const promptForms = secrets.flatMap((value) => {
    if (!value) return [];
    const xmlEscaped = escapePromptData(value);
    return xmlEscaped === value ? [value] : [value, xmlEscaped];
  });
  if (promptForms.length === 0) return text;
  const quoteSecretForms = secrets.flatMap((value) => {
    if (!value) return [];
    const encoded = JSON.stringify(value).slice(1, -1);
    const xmlEscaped = escapePromptData(value);
    return [
      value,
      xmlEscaped,
      encoded,
      encoded.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
    ];
  });
  const wholeMatches = createSecretMatcher(promptForms).ranges(text);
  const redactOutside = (chunk: string) => redactSecrets(chunk, promptForms);
  const redactQuoteBody = (body: string) => {
    const cleaned = redactJsonStringsAndPlainText(
      body,
      (value) => redactSecrets(value, promptForms),
      (value) => redactSecrets(value, quoteSecretForms),
      promptForms,
    );
    return cleaned === body ? body : cleaned.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  };
  let out = "";
  let emitCursor = 0;
  let scanPos = 0;
  const exhausted = [false, false];
  const cachedOpen = [-1, -1];
  const cachedClose = [-1, -1];
  while (scanPos < text.length) {
    let nextIndex = -1;
    let nextTagIndex = -1;
    for (let i = 0; i < REPLY_TARGET_TAGS.length; i += 1) {
      if (exhausted[i]) continue;
      if (cachedOpen[i]! < scanPos) {
        cachedOpen[i] = text.indexOf(REPLY_TARGET_TAGS[i]!.open, scanPos);
      }
      const at = cachedOpen[i]!;
      if (at === -1) {
        exhausted[i] = true;
        continue;
      }
      if (nextIndex === -1 || at < nextIndex) {
        nextIndex = at;
        nextTagIndex = i;
      }
    }
    if (nextIndex === -1 || nextTagIndex === -1) break;
    const tag = REPLY_TARGET_TAGS[nextTagIndex]!;
    const bodyStart = nextIndex + tag.open.length;
    if (cachedClose[nextTagIndex]! < bodyStart) {
      cachedClose[nextTagIndex] = text.indexOf(tag.close, bodyStart);
    }
    const closeIndex = cachedClose[nextTagIndex]!;
    if (closeIndex === -1) {
      exhausted[nextTagIndex] = true;
      scanPos = bodyStart;
      continue;
    }
    if (cachedOpen[nextTagIndex]! < bodyStart) {
      cachedOpen[nextTagIndex] = text.indexOf(tag.open, bodyStart);
    }
    const innerOpen = cachedOpen[nextTagIndex]!;
    if (innerOpen !== -1 && innerOpen < closeIndex) {
      scanPos = innerOpen;
      continue;
    }
    const closeEnd = closeIndex + tag.close.length;
    if (
      overlapsSortedRange(wholeMatches, nextIndex, bodyStart) ||
      overlapsSortedRange(wholeMatches, closeIndex, closeEnd)
    ) {
      scanPos = bodyStart;
      continue;
    }
    out += redactOutside(text.slice(emitCursor, nextIndex));
    out += tag.open + redactQuoteBody(text.slice(bodyStart, closeIndex)) + tag.close;
    emitCursor = closeEnd;
    scanPos = closeEnd;
  }
  if (emitCursor < text.length) out += redactOutside(text.slice(emitCursor));
  return out;
}

/**
 * The runtime's record of a turn as the reply keeps it: tool arguments and results cleaned as
 * kept calls are, the run's secrets redacted everywhere, and none for a turn that used a tool
 * whose results are never kept.
 */
export function keptTurnTranscript(transcript: string, secrets: string[]): string | undefined {
  return mapTurnTranscript(
    transcript,
    (text, kind) =>
      kind === "arguments" || kind === "result"
        ? cleanToolText(text, secrets)
        : kind === "prompt"
          ? redactStoredPrompt(text, secrets)
          : redactSecrets(text, secrets),
    (name) => !SECRET_TOOL.test(name),
    (args) => redactToolArgsForReview(args, secrets),
  );
}

/** Adds a finished call's result to the call its step keeps, within the reply's result budget. */
export function keepToolStepResult(
  reply: Pick<
    ReplyState,
    "toolStepCalls" | "keptResultChars" | "latestScreenshot" | "earlyCompletions"
  >,
  completion: AgentToolCompletion,
  secrets: string[],
): void {
  const call = reply.toolStepCalls.get(completion.executionId);
  if (!call) {
    // A fast call can finish before its own call event is handled; that handler keeps it then.
    reply.earlyCompletions ??= new Map();
    reply.earlyCompletions.set(completion.executionId, completion);
    return;
  }
  // An error, an error result or a non-zero exit, as the step's outcome counts it.
  const failed = toolCompletionOutcome(completion) === "failed" ? ({ failed: true } as const) : {};
  const left = TOOL_REPLY_RESULTS_MAX_CHARS - reply.keptResultChars;
  // Once the reply's budget is spent, later calls keep how they ended but not what they returned.
  const result =
    left >= TOOL_RESULT_MIN_CHARS
      ? keptToolResult(completion, secrets, Math.min(TOOL_CALL_TEXT_MAX_CHARS, left))
      : undefined;
  if (result !== undefined) reply.keptResultChars += result.length;
  const image = screenshotOf(completion);
  if (image) reply.latestScreenshot = { executionId: completion.executionId, ...image };
  reply.toolStepCalls.set(completion.executionId, {
    ...call,
    ...(result === undefined ? {} : { result }),
    ...failed,
  });
}

/**
 * Whether replayed history hands the model any kept result or screenshot. Such text could carry
 * injected instructions, even from a tool that reads the bot's own state (a saved page holds what
 * an earlier run copied in), so the run starts as one that has read outside content.
 */
export function historyReplaysOutsideContent(history: AgentRunRequest["history"]): boolean {
  return history.some(
    (entry) =>
      Boolean(turnTranscriptResults(entry.transcript)?.length) ||
      entry.segments?.some(
        (segment) =>
          "steps" in segment &&
          segment.steps.some((step) =>
            step.calls?.some((call) => call.result !== undefined || call.image !== undefined),
          ),
      ),
  );
}

/** The kept results replayed history hands the model, oldest first. */
export function historyToolResults(history: AgentRunRequest["history"]): unknown[] {
  return history.flatMap(
    (entry) =>
      // A stored turn replays its results whole, so those are what the model reads. One that
      // cannot be read replays from the reply's kept results.
      turnTranscriptResults(entry.transcript) ??
      (entry.segments ?? []).flatMap((segment) =>
        "steps" in segment
          ? segment.steps.flatMap((step) =>
              (step.calls ?? []).flatMap((call) =>
                call.result === undefined ? [] : [call.result],
              ),
            )
          : [],
      ),
  );
}

/** The image a call returned (a screenshot), when it is one this product stores. */
function screenshotOf(completion: AgentToolCompletion) {
  if (
    completion.paused ||
    completion.error !== undefined ||
    SECRET_TOOL.test(completion.name) ||
    PICTURE_READING_TOOLS.has(completion.name)
  )
    return undefined;
  const content = (completion.result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const part = content.findLast((item: { type?: unknown }) => item?.type === "image") as
    | { data?: unknown; mimeType?: unknown }
    | undefined;
  const mimeType =
    typeof part?.mimeType === "string" ? storedImageMimeType(part.mimeType) : undefined;
  if (!mimeType || typeof part?.data !== "string") return undefined;
  return { mimeType, data: new Uint8Array(Buffer.from(part.data, "base64")) };
}

/**
 * Saves the screenshot the reply's last image-returning call took, and points that call at it, so
 * a later turn replays the reply with the image as the bot saw it. Saved once, with the reply, so
 * the stored reply (and its replay) never changes afterwards. A failed save leaves the call as
 * `[image not kept]`, as before.
 */
export async function saveLatestStepScreenshot(ctx: RunContext): Promise<void> {
  const { reply } = ctx.state;
  const shot = reply.latestScreenshot;
  reply.latestScreenshot = undefined;
  const call = shot && reply.toolStepCalls.get(shot.executionId);
  if (!shot || !call || !ctx.deps.artifacts) return;
  try {
    const artifactId = await storeStepScreenshot(
      { prisma: ctx.deps.prisma, artifacts: ctx.deps.artifacts },
      {
        spaceId: ctx.run.spaceId,
        userId: ctx.run.userId,
        botId: ctx.bot.id,
        groupId: ctx.thread.groupId ?? undefined,
        runId: ctx.runId,
        operationId: `${ctx.runId}:${shot.executionId}:screenshot`,
        image: shot,
      },
    );
    reply.toolStepCalls.set(shot.executionId, { ...call, image: { artifactId } });
  } catch (error) {
    getLogger().error("step screenshot save", error);
  }
}
