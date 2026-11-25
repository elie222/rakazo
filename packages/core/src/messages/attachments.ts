import type { AttachmentMimeType, HistoryToolStep, MessageBlock } from "@rakazo/contracts";
import {
  AGENT_IMPORT_ASK_ACTION_ID,
  ATTACHMENT_COUNT_CEILING,
  ATTACHMENT_MAX_BYTES,
  attachmentSizeLabel,
  isAllowedAttachmentMimeType,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";
import { askOptionLetter, isQuestionAskBlock } from "../asks/ask-kind.js";
import { sliceWellFormed } from "../primitives/utf8.js";
import { isApprovalAskBlock, isSecretAskBlock } from "../runs/action-approval.js";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

/**
 * Validates base64 without a grouped-repetition regex over the whole string:
 * `/^(?:[A-Za-z0-9+/]{4})*(...)?$/` overflows V8's regex stack on multi-megabyte
 * inputs, which ordinary attachments reach. A flat `[chars]*` quantifier does not;
 * padding is checked separately since it can only be the trailing 0-2 characters.
 */
function isWellFormedBase64(value: string): boolean {
  const paddingMatch = /={1,2}$/.exec(value);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  const body = paddingLength > 0 ? value.slice(0, value.length - paddingLength) : value;
  if (body.includes("=")) return false;
  return /^[A-Za-z0-9+/]*$/.test(body);
}

const DEFAULT_SERVER_ATTACHMENT_COUNT = 10;

export function attachmentCountFromEnv(source: { MAX_ATTACHMENTS_PER_MESSAGE?: string }): number {
  const value = source.MAX_ATTACHMENTS_PER_MESSAGE?.trim();
  if (!value) return DEFAULT_SERVER_ATTACHMENT_COUNT;
  const count = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > ATTACHMENT_COUNT_CEILING
  ) {
    throw new Error(
      `MAX_ATTACHMENTS_PER_MESSAGE must be an integer from 1 to ${ATTACHMENT_COUNT_CEILING}`,
    );
  }
  return count;
}

export function uploadSizeFromEnv(source: { MAX_UPLOAD_SIZE_MB?: string }): number {
  const value = source.MAX_UPLOAD_SIZE_MB?.trim();
  if (!value) return ATTACHMENT_MAX_BYTES;
  const mb = Number(value);
  // Leave room for base64 expansion and the JSON envelope in the HTTP body guard.
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(mb) ||
    mb <= 0 ||
    mb > Math.floor(Number.MAX_SAFE_INTEGER / (2 * 1024 * 1024))
  ) {
    throw new Error(
      "MAX_UPLOAD_SIZE_MB must be a positive integer number of MiB within the safe byte range",
    );
  }
  return mb * 1024 * 1024;
}

export function decodeAttachmentBase64(
  contentBase64: string,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Uint8Array {
  const normalized = contentBase64.trim();
  if (!normalized) throw new AttachmentValidationError("Attachment content is empty");
  if (normalized.length > Math.ceil(maxBytes / 3) * 4) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  if (normalized.length % 4 !== 0 || !isWellFormedBase64(normalized)) {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  return new Uint8Array(bytes);
}

export function validateAttachmentMimeType(mimeType: string): void {
  if (!isAllowedAttachmentMimeType(mimeType)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${mimeType}`);
  }
}

export function attachmentKindForMimeType(mimeType: string): "image" | "file" {
  return isAttachmentImageMimeType(mimeType) ? "image" : "file";
}

export function messageBlockForArtifact(artifact: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}): Extract<MessageBlock, { kind: "image" | "file" }> {
  if (attachmentKindForMimeType(artifact.mimeType) === "image") {
    return {
      kind: "image",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
    };
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

/** Untrusted transcript text is bounded before it reaches a prompt. */
const VOICE_TRANSCRIPT_MAX_CHARS = 4000;

/** Keeps tabs and newlines, drops C0, DEL and C1 control characters, trims and bounds the text. */
export function normalizeVoiceTranscript(value: string | null | undefined): string {
  if (!value) return "";
  const printable = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 9 || code === 10) return true;
      return code >= 32 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
  return sliceWellFormed(printable.trim(), VOICE_TRANSCRIPT_MAX_CHARS);
}

export function promptTextForAttachments(
  text: string | undefined,
  artifacts: Array<{
    name: string;
    mimeType: string;
    size: number;
    /** Normalized words transcribed from an inbound audio attachment. */
    transcript?: string;
  }>,
): string {
  const caption = text?.trim() ?? "";
  const notes = artifacts
    .filter((artifact) => !isAttachmentImageMimeType(artifact.mimeType))
    .map((artifact) => {
      const note = `User attached file ${JSON.stringify(artifact.name)} (${artifact.mimeType}, ${artifact.size} bytes).`;
      return artifact.transcript
        ? `${note}\n[voice note transcript: ${artifact.transcript}]`
        : note;
    });
  return [caption, ...notes].filter(Boolean).join("\n\n") || "See attached files.";
}

const TOOL_STEP_NOTE_MAX_CHARS = 300;
const TOOL_STEP_MAX_LINES = 40;
/** Tool names are at most 64 characters; only imported data could carry a longer label. */
const TOOL_STEP_LABEL_MAX_CHARS = 80;

/**
 * An earlier reply's tool steps as the bot sees them again: label, count and note. Replay caps
 * notes and steps; history reads pass `full`, since they page through long text themselves.
 */
export function toolStepsHistoryText(
  steps: Extract<MessageBlock, { kind: "steps" }>["steps"],
  { full = false, redact }: { full?: boolean; redact?: (text: string) => string } = {},
): string {
  // Stored blocks can come from an account import, so skip malformed entries instead of throwing.
  const valid = Array.isArray(steps) ? steps.filter((step) => typeof step?.label === "string") : [];
  if (valid.length === 0) return "";
  const shown = full ? valid : valid.slice(0, TOOL_STEP_MAX_LINES);
  const lines = shown.map((step) => {
    // Redact raw label and note before whitespace folding, trimming or truncation so
    // padded or long credentials still match.
    const rawLabel = redact ? redact(step.label) : step.label;
    const name =
      !full && rawLabel.length > TOOL_STEP_LABEL_MAX_CHARS
        ? `${sliceWellFormed(rawLabel, TOOL_STEP_LABEL_MAX_CHARS)}…`
        : rawLabel;
    const stepCount =
      typeof step.count === "number" && Number.isInteger(step.count) && step.count > 0
        ? step.count
        : Number.NaN;
    const counted = stepCount > 1 ? `${name} ×${stepCount}` : name;
    const outcome = toolStepOutcomeText(step);
    const label = outcome ? `${counted} (${outcome})` : counted;
    const rawNote = typeof step.note === "string" ? (redact ? redact(step.note) : step.note) : "";
    const whole = rawNote.replace(/\s+/g, " ").trim();
    const note =
      !full && whole.length > TOOL_STEP_NOTE_MAX_CHARS
        ? `${sliceWellFormed(whole, TOOL_STEP_NOTE_MAX_CHARS)}…`
        : whole;
    return note ? `- ${label}: ${note}` : `- ${label}`;
  });
  const hidden = valid.length - shown.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more`);
  // "Made" rather than "ran": a call the loop guard stopped is still recorded as a step.
  return `[tool calls this reply made]\n${lines.join("\n")}`;
}

const TOOL_STEP_OUTCOMES = ["succeeded", "failed", "stopped"] as const;

/** "succeeded" when every call ended the same way, else "2 succeeded, 1 failed". */
export function toolStepOutcomeText(step: { count: number; outcomes?: unknown }): string {
  const outcomes = (step.outcomes ?? {}) as Partial<Record<string, unknown>>;
  if (typeof outcomes !== "object" || outcomes === null) return "";
  const counts = TOOL_STEP_OUTCOMES.flatMap((outcome) => {
    const raw = outcomes[outcome];
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0
      ? [{ outcome, count: raw }]
      : [];
  });
  const [only] = counts;
  const stepCount =
    typeof step.count === "number" && Number.isInteger(step.count) && step.count > 0
      ? step.count
      : Number.NaN;
  if (counts.length === 1 && only?.count === stepCount) return only.outcome;
  return counts.map(({ outcome, count }) => `${count} ${outcome}`).join(", ");
}

export function blocksToAgentHistoryText(
  blocks: MessageBlock[],
  redact?: (text: string) => string,
): string {
  return blocks
    .map((block) => blockHistoryText(block, redact))
    .filter(Boolean)
    .join("\n");
}

/** A reply in order, with its tool steps apart from the text around them. */
export type AgentHistorySegment = { text: string } | { steps: HistoryToolStep[] };

export function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "number") {
    const text = String(value);
    const redacted = redact(text);
    return redacted === text ? value : redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redact));
  if (value && typeof value === "object") {
    // Use a null-prototype object so a "__proto__" key stays an own data property on stringify.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redact(key)] = redactJsonValue(item, redact);
    }
    return out;
  }
  return value;
}

const BOUNDED_OMISSION_MARKER = /(\n… \[\d+ characters not kept\] …\n)/;
const JSON_VALUE_TOKEN =
  /"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

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

function isJsonWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
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

function redactSingleJsonStringToken(token: string, redact: (text: string) => string): string {
  try {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== "string") return token;
    const next = redact(decoded);
    return next === decoded ? token : JSON.stringify(next);
  } catch {
    // Truncated trailing string literal in cut-off JSON (including a lone trailing backslash).
    const { trimmed, trailing: trailingEscape } = splitTrailingIncompleteJsonEscape(token);
    try {
      const decoded: unknown = JSON.parse(`${trimmed}"`);
      if (typeof decoded !== "string") return token;
      const next = redact(decoded);
      return next === decoded ? token : `${JSON.stringify(next).slice(0, -1)}${trailingEscape}`;
    } catch {
      return token;
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

function redactJsonSegment(
  segment: string,
  afterOmission: boolean,
  redact: (text: string) => string,
): string {
  const replaceTokens = (chunk: string) =>
    chunk.replace(JSON_VALUE_TOKEN, (token, offset: number, source: string) =>
      redactJsonValueToken(token, offset, source, redact),
    );
  if (afterOmission) {
    const lineBreak = segment.search(/[\r\n]/);
    const firstLine = lineBreak >= 0 ? segment.slice(0, lineBreak) : segment;
    const restLines = lineBreak >= 0 ? segment.slice(lineBreak) : "";
    const firstQuotes = findUnescapedQuotes(firstLine);
    // Cutting between the two backslashes of a trailing `\\"` leaves `\"` right before a delimiter.
    if (/^\\"\s*(?:[,}\]:]|$)/.test(firstLine) && firstQuotes.length % 2 === 0) {
      return `\\"${replaceTokens(segment.slice(2))}`;
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
          replaceTokens(segment.slice(firstQuote + 1))
        );
      }
    } else if (firstLine.includes("\\")) {
      return redactJsonTailPrefix(firstLine, redact) + replaceTokens(restLines);
    }
  }
  return replaceTokens(segment);
}

function redactJsonStringTokens(raw: string, redact: (text: string) => string): string {
  const parts = raw.split(BOUNDED_OMISSION_MARKER);
  if (parts.length === 1) return redactJsonSegment(raw, false, redact);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : redactJsonSegment(part, index > 0, redact)))
    .join("");
}

export function redactJsonText(raw: string, redact: (text: string) => string): string {
  return redact(redactJsonStringTokens(raw, redact));
}

/**
 * The same reply as blocksToAgentHistoryText, split at its tool steps so a runtime can replay
 * them as tool calls. Text between steps is joined as blocksToAgentHistoryText joins it.
 */
export function blocksToAgentHistorySegments(
  blocks: MessageBlock[],
  redact?: (text: string) => string,
): AgentHistorySegment[] {
  const segments: AgentHistorySegment[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) segments.push({ text: text.join("\n") });
    text = [];
  };
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.kind === "steps") {
      // Stored blocks can come from an account import, so skip malformed entries.
      const steps = Array.isArray(block.steps)
        ? (block.steps as HistoryToolStep[])
            .filter(
              (step) => step !== null && typeof step === "object" && typeof step.label === "string",
            )
            .map((step) => {
              const { calls: rawCalls, note: rawNote, count: rawCount, ...rest } = step;
              const count =
                typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount > 0
                  ? rawCount
                  : 0;
              const note =
                typeof rawNote === "string" ? (redact ? redact(rawNote) : rawNote) : undefined;
              const calls = Array.isArray(rawCalls)
                ? rawCalls
                    .filter(
                      (call): call is NonNullable<HistoryToolStep["calls"]>[number] =>
                        call !== null && typeof call === "object",
                    )
                    .map((call) => {
                      const { arguments: rawArguments, result: rawResult, ...callRest } = call;
                      return {
                        ...callRest,
                        ...(typeof rawArguments === "string"
                          ? {
                              arguments: redact
                                ? redactJsonText(rawArguments, redact)
                                : rawArguments,
                            }
                          : {}),
                        ...(typeof rawResult === "string"
                          ? { result: redact ? redactJsonText(rawResult, redact) : rawResult }
                          : {}),
                      };
                    })
                : undefined;
              return {
                ...rest,
                label: redact ? redact(step.label) : step.label,
                count,
                ...(note !== undefined ? { note } : {}),
                ...(calls ? { calls } : {}),
              };
            })
        : [];
      if (!steps.length) continue;
      flush();
      segments.push({ steps });
      continue;
    }
    const rendered = blockHistoryText(block, redact);
    if (rendered) text.push(rendered);
  }
  flush();
  return segments;
}

function safeHistoryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function blockHistoryText(block: MessageBlock, redact?: (text: string) => string): string {
  if (!block || typeof block !== "object") return "";
  const clean = (value: unknown): string => {
    const text = safeHistoryText(value);
    return redact ? redact(text) : text;
  };
  if (block.kind === "text") {
    return clean(block.text);
  }
  // The tools a reply used, and what the bot wrote before each, are kept out of its text;
  // without them a later turn cannot tell what it already did.
  if (block.kind === "steps") return toolStepsHistoryText(block.steps, { redact });
  if (block.kind === "chart") return `[chart: ${clean(block.name)}]`;
  if (block.kind === "app") return `[app: ${clean(block.server)} showed ${clean(block.tool)}]`;
  if (block.kind === "image") return `[image: ${clean(block.name)}]`;
  // The id lets a later turn, or another chat, update this page instead of making a new one.
  if (block.kind === "page") {
    return `[page: ${clean(block.title)} (pageId ${safeHistoryText(block.pageId)}, version ${safeHistoryText(block.version)})]`;
  }
  if (block.kind === "file") {
    return `[file: ${clean(block.name)} (${safeHistoryText(block.mimeType)}, ${safeHistoryText(block.size)} bytes)]`;
  }
  // Keep attribution on peer messages: without it a later turn cannot tell
  // which lines came from another bot rather than the user.
  if (block.kind === "bot_message_received")
    return `[from ${clean(block.fromBotName)}] ${clean(block.text)}`;
  if (block.kind === "bot_message_sent")
    return `[to ${clean(block.toBotName)}] ${clean(block.text)}`;
  if (block.kind === "channel_message")
    return `[from ${clean(block.fromLabel)}] ${clean(block.text)}`;
  if (block.kind === "handoff") {
    return `[handoff ${safeHistoryText(block.fromBotId)} -> ${safeHistoryText(block.toBotId)}] ${clean(block.text)}`;
  }
  // Without the answer a later turn sees the question as still open and asks it again.
  if (block.kind === "ask") {
    // A question card keeps its draft in the detail, and a later turn still needs
    // it: approval cards repeat tool arguments the call itself records, and secret
    // cards keep their detail hidden. The draft is fenced so a line in it cannot
    // pass for the answer; only something that reads as a closing draft tag (any case or
    // spacing) is escaped, so the bot reads the rest of its draft verbatim (an address
    // like "Ana <ana@example.test>" stays as written).
    const detail =
      typeof block.detail === "string" &&
      block.detail &&
      !isApprovalAskBlock(block) &&
      !isSecretAskBlock(block)
        ? `\n<draft>\n${clean(block.detail).replace(/<\s*\/\s*draft\s*>/gi, "&lt;/draft&gt;")}\n</draft>`
        : "";
    // The card shows its options lettered, and a typed reply like "A and C" refers to them.
    // The import button opens a flow rather than answering, so it is not an option here. A
    // label is kept to one line so it cannot pass for the answer.
    const validActions = Array.isArray(block.actions)
      ? block.actions.filter(
          (action): action is { id: string; label: string } =>
            action !== null &&
            typeof action === "object" &&
            typeof action.id === "string" &&
            typeof action.label === "string",
        )
      : [];
    const options = isQuestionAskBlock(block)
      ? validActions
          .filter((action) => action.id !== AGENT_IMPORT_ASK_ACTION_ID)
          .map(
            (action, index) =>
              `\n${askOptionLetter(index)}. ${clean(action.label).replace(/\s+/g, " ")}`,
          )
      : [];
    const question = `${clean(block.text)}${options.join("")}${detail}`;
    const rawAnswer = safeHistoryText(block.answer);
    if (block.status !== "answered" || !rawAnswer) return question;
    const choice = validActions.find((action) => action.id === rawAnswer);
    const answerText = choice ? choice.label : rawAnswer;
    return `${question}\nAnswer: ${clean(answerText)}`;
  }
  // The bot needs the outcome of its own call: a missed call is its cue to follow up.
  if (block.kind === "call_request") {
    const outcomes = {
      ringing: "still ringing",
      answered: "the user answered",
      declined: "the user declined it",
      missed: "the user did not answer",
    } as const;
    const outcome =
      typeof block.status === "string" && Object.hasOwn(outcomes, block.status)
        ? outcomes[block.status as keyof typeof outcomes]
        : "";
    return `[you called the user about: ${clean(block.reason)}; ${outcome}]${block.status === "answered" ? `\n${clean(block.opening)}` : ""}`;
  }
  // Whether the person answered a tool's question, never what was asked or sent: the question
  // is the server's own text and the answer went to the server.
  if (block.kind === "tool_question") {
    const outcomes = {
      pending: "waiting for the user",
      accepted: "the user answered",
      declined: "the user declined",
      expired: "the user did not answer",
    } as const;
    const outcome =
      typeof block.status === "string" && Object.hasOwn(outcomes, block.status)
        ? outcomes[block.status as keyof typeof outcomes]
        : "";
    const source =
      block.question && typeof block.question === "object"
        ? clean((block.question as { source?: unknown }).source)
        : "";
    return `[${source} asked the user a question during a tool call; ${outcome}]`;
  }
  if ("text" in block && typeof block.text === "string") return clean(block.text);
  return "";
}

const EXTENSION_MIME_TYPES: Record<string, AttachmentMimeType> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
};

const MIME_TYPE_EXTENSIONS: Record<AttachmentMimeType, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/3gpp": ".3gp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/html": ".html",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
};

/** Short file-type badge, as a file's extension reads ("TXT", "MD", "PDF"). */
export function artifactTypeLabel(mimeType: string): string {
  const extension = attachmentExtensionForMimeType(mimeType);
  if (extension) return extension.slice(1).toUpperCase();
  const slash = mimeType.indexOf("/");
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase().slice(0, 6);
}

export function inferAttachmentMimeType(
  name: string,
  reportedType?: string,
): AttachmentMimeType | null {
  const archiveAliases: Record<string, AttachmentMimeType> = {
    "application/x-zip-compressed": "application/zip",
    "application/x-zip": "application/zip",
    "multipart/x-zip": "application/zip",
    "application/x-rar-compressed": "application/vnd.rar",
    "application/x-rar": "application/vnd.rar",
    "application/rar": "application/vnd.rar",
    "application/x-7z": "application/x-7z-compressed",
  };
  if (reportedType && Object.hasOwn(archiveAliases, reportedType)) {
    return archiveAliases[reportedType]!;
  }
  const audioAliases: Record<string, AttachmentMimeType> = {
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
  };
  if (reportedType && Object.hasOwn(audioAliases, reportedType)) return audioAliases[reportedType]!;
  // audio/aac may describe an M4A's codec, not its container. Infer from .m4a;
  // do not advertise standalone AAC streams as MP4 containers.
  const dot = name.lastIndexOf(".");
  const extensionType = dot < 0 ? undefined : EXTENSION_MIME_TYPES[name.slice(dot).toLowerCase()];
  // Some browsers and native document pickers report Markdown as text/plain.
  if (extensionType === "text/markdown" && (!reportedType || reportedType === "text/plain")) {
    return extensionType;
  }
  // Windows reports .csv as an Excel file when Excel is installed.
  if (extensionType === "text/csv" && reportedType === "application/vnd.ms-excel") {
    return extensionType;
  }
  if (reportedType && isAllowedAttachmentMimeType(reportedType)) return reportedType;
  return extensionType ?? null;
}

export function attachmentExtensionForMimeType(mimeType: string): string {
  return isAllowedAttachmentMimeType(mimeType) ? MIME_TYPE_EXTENSIONS[mimeType] : "";
}

const OFFICE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * The name an Office file is stored and downloaded under ends in its type's own extension, so a file accepted as a
 * Word document cannot be saved as "Invoice.docm" (a macro-enabled name) and opened by Office as one. Other types keep
 * the name they were given.
 */
export function attachmentStoredName(name: string, mimeType: string): string {
  if (!OFFICE_MIME_TYPES.has(mimeType)) return name;
  const extension = attachmentExtensionForMimeType(mimeType);
  if (name.toLowerCase().endsWith(extension)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}${extension}`;
}

/** Where a run copies an attached file in the bot's workspace; history tools report the same path. */
export function attachmentComputerPath(artifactId: string, mimeType: string): string {
  return `attachments/${artifactId}${attachmentExtensionForMimeType(mimeType)}`;
}

export function attachmentsForThread<T extends { threadKey: string }>(
  attachments: readonly T[],
  threadKey: string | undefined,
): T[] {
  if (!threadKey) return [];
  return attachments.filter((attachment) => attachment.threadKey === threadKey);
}

export function attachmentsForBot<T extends { botId: string }>(
  attachments: readonly T[],
  botId: string | undefined,
): T[] {
  if (!botId) return [];
  return attachments.filter((attachment) => attachment.botId === botId);
}

/**
 * The message whose attachments this run receives: a person's message, or a message or
 * handoff another bot delivered, whose files arrive the same way.
 */
export function userTurnMessageForRun<
  T extends { id?: string; role: string; runId?: string | null; blocks: MessageBlock[] },
>(trigger: string, runId: string, messages: T[], sourceMessageId?: string | null): T | undefined {
  if (trigger === "bot_message" || trigger === "follow_up") {
    if (!sourceMessageId) return undefined;
    return messages.find(
      (message) =>
        message.id === sourceMessageId &&
        message.blocks.some(
          (block) => block.kind === "bot_message_received" || block.kind === "handoff",
        ),
    );
  }
  if (trigger === "helper")
    return messages.find((message) => message.role === "user" && message.runId === runId);
  if (trigger !== "user" && trigger !== "messaging" && trigger !== "reaction") return undefined;
  return messages.find(
    (message) =>
      message.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.runId === runId),
  );
}

/** Bound PNG inspection before image decoding on every client. */
export const PNG_ANIMATION_HEADER_BYTES = 64 * 1024;

/** Only re-encode PNGs whose header confirms they are static; unknown stays original. */
export function isStaticPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (offset: number) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || typeAt(8) !== "IHDR") return false;
  const end = Math.min(bytes.length, PNG_ANIMATION_HEADER_BYTES);
  for (let offset = 33; offset + 8 <= end; ) {
    const type = typeAt(offset);
    // An APNG must declare acTL before its first IDAT, even with one animation frame.
    if (type === "acTL" || type === "IEND") return false;
    if (type === "IDAT") return true;
    const next = offset + 12 + view.getUint32(offset);
    if (next > end) return false;
    offset = next;
  }
  return false;
}
