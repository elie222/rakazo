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
import {
  redactComposioApiKeyAssignments,
  redactCredentialJsonFields,
} from "./secret-assignment-text.js";
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

/** Assignment scan, then the shared text sanitizer. Used on decoded JSON strings and plain gaps. */
function redactDecodedToolText(value: string, options?: { decoded?: boolean }): string {
  return sanitizeSensitiveText(redactComposioApiKeyAssignments(value), options);
}

function cleanToolText(text: string, secrets: string[], honorOmissionMarker = false): string {
  const secretForms = secrets.flatMap((value) => {
    if (!value) return [];
    const encoded = JSON.stringify(value).slice(1, -1);
    return [value, encoded, encoded.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")];
  });
  // Exact secrets first. A later pattern must not change the text a registered secret matches.
  const withSecrets = redactJsonStringsAndPlainText(
    text,
    (value) => redactSecrets(value, secrets),
    (value) => redactSecrets(value, secretForms),
    secrets,
  );
  const cleaned = redactJsonStringsAndPlainText(
    redactComposioApiKeyAssignments(withSecrets),
    (value) => redactDecodedToolText(value, { decoded: true }),
    (value) => redactDecodedToolText(value, { decoded: true }),
  );
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
