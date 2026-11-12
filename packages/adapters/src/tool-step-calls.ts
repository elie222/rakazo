import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import type { ToolStepCall } from "@rakazo/core";
import { redactSecrets } from "@rakazo/core";
import { redactToolArgsForReview } from "./auto-review.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";
import type { ReplyState } from "./run-context.js";

/**
 * The most of one call's result, or of any one text in its arguments, kept for later turns. The
 * bound is applied once, when the reply is saved, so the replay of a reply never changes.
 */
export const TOOL_CALL_TEXT_MAX_CHARS = 1_000;
/** The most of all results one reply keeps; later results get what is left, at least a line. */
export const TOOL_REPLY_RESULTS_MAX_CHARS = 8_000;
const TOOL_RESULT_MIN_CHARS = 200;
/** Lists and nesting in arguments are kept generously; only pathological shapes are bounded. */
const ARGUMENT_ITEMS_MAX = 100;
const ARGUMENT_DEPTH_MAX = 8;

/** Stands in for an image a call returned; replay says what the bot wrote after seeing it. */
export const IMAGE_NOT_KEPT = "[image not kept]";

/**
 * Text bounded to `max` characters, keeping its start and end (where a command's output usually
 * ends with what matters) and saying how much was left out, so it never reads as unfinished.
 * Secrets are redacted in each kept part, with a margin so one cut at the edge is still caught.
 */
export function bounded(text: string, max: number, secrets: string[] = []): string {
  const clean = (part: string) => sanitizeSensitiveText(redactSecrets(part, secrets));
  if (text.length <= max) return clean(text);
  const margin = 200;
  const headLength = Math.floor(max * 0.7);
  const tailLength = max - headLength;
  const head = clean(text.slice(0, headLength + margin)).slice(0, headLength);
  const tail = clean(text.slice(-(tailLength + margin))).slice(-tailLength);
  return `${head}\n… [${text.length - max} characters not kept] …\n${tail}`;
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
  if (completion.paused || SECRET_TOOL.test(completion.name)) return undefined;
  let text: string;
  if (completion.error !== undefined) text = sanitizeConnectorError(completion.error, secrets);
  else {
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
  const whole = text.trim();
  return whole ? bounded(whole, max, secrets) : undefined;
}

/** Adds a finished call's result to the call its step keeps, within the reply's result budget. */
export function keepToolStepResult(
  reply: Pick<ReplyState, "toolStepCalls" | "keptResultChars">,
  completion: AgentToolCompletion,
  secrets: string[],
): void {
  const call = reply.toolStepCalls.get(completion.executionId);
  if (!call) return;
  const left = TOOL_REPLY_RESULTS_MAX_CHARS - reply.keptResultChars;
  const max = Math.max(TOOL_RESULT_MIN_CHARS, Math.min(TOOL_CALL_TEXT_MAX_CHARS, left));
  const result = keptToolResult(completion, secrets, max);
  if (result === undefined) return;
  reply.keptResultChars += result.length;
  reply.toolStepCalls.set(completion.executionId, { ...call, result });
}
