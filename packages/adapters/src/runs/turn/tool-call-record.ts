import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import type { ToolCallOutcome, ToolCallRecord } from "@rakazo/contracts";
import {
  TOOL_CALL_ARGUMENTS_MAX_CHARS,
  TOOL_CALL_ERROR_MAX_CHARS,
  TOOL_CALL_HISTORY_TEXT_MAX_CHARS,
  TOOL_CALL_RESULT_HEAD_MAX_CHARS,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createToolCallRecord } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizeConnectorError } from "../../integrations/connector-safety.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";
import { toolResultError } from "./tool-result-error.js";
import {
  bounded,
  IMAGE_NOT_KEPT,
  keptToolArguments,
  secretCarryingTool,
} from "./tool-step-calls.js";

/** What one call's trace holds, already redacted with the run's secrets and capped. */
export type ToolCallTrace = {
  executionId: string;
  tool: string;
  durationMs: number;
  outcome: ToolCallOutcome;
  arguments?: string;
  error?: string;
  resultBytes?: number;
  resultShortened?: boolean;
  resultHead?: string;
};

/** The text a call returned, joined as the model read it; images stand in for themselves. */
function resultText(completion: AgentToolCompletion): string | undefined {
  const content = (completion.result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : part?.type === "image"
          ? IMAGE_NOT_KEPT
          : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * One call's trace, built before anything is stored: the arguments and any error or result head are
 * redacted with the run's secrets and capped, so nothing else ever holds the raw values.
 */
export function toolCallTrace(completion: AgentToolCompletion, secrets: string[]): ToolCallTrace {
  const outcome: ToolCallOutcome = completion.paused
    ? "paused"
    : toolCompletionOutcome(completion) === "failed"
      ? "failed"
      : "succeeded";
  const failure =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const error = failure === undefined ? undefined : sanitizeConnectorError(failure, secrets);
  const kept = completion.paused || secretCarryingTool(completion.name);
  const text = kept ? undefined : resultText(completion);
  const head =
    text === undefined ? undefined : bounded(text, TOOL_CALL_RESULT_HEAD_MAX_CHARS, secrets);
  const bytes = text === undefined ? undefined : Buffer.byteLength(text, "utf8");
  return {
    executionId: completion.executionId,
    tool: completion.name,
    durationMs: completion.durationMs,
    outcome,
    arguments: bounded(
      keptToolArguments(completion.arguments, secrets) ?? "{}",
      TOOL_CALL_ARGUMENTS_MAX_CHARS,
      secrets,
    ),
    ...(error === undefined ? {} : { error: bounded(error, TOOL_CALL_ERROR_MAX_CHARS, secrets) }),
    ...(head === undefined || bytes === undefined
      ? {}
      : {
          resultBytes: bytes,
          ...(completion.resultShortened ? { resultShortened: true } : {}),
          resultHead: head,
        }),
  };
}

/** Where a call's trace belongs: the run that made it, and the Space that may keep it. */
export type ToolCallTraceTarget = {
  spaceId: string;
  threadId: string;
  botId: string;
  runId: string;
};

/**
 * Keeps the trace of a finished call when the Space still keeps them. Never throws: a run's own work
 * must not fail because its explanation could not be stored, so a refused or broken write is logged.
 */
export async function recordToolCall(
  prisma: Pick<PrismaClient, "toolCallRecord">,
  keepsRecords: boolean,
  target: ToolCallTraceTarget,
  completion: AgentToolCompletion,
  secrets: string[],
): Promise<void> {
  if (!keepsRecords) return;
  const trace = toolCallTrace(completion, secrets);
  try {
    await createToolCallRecord(prisma, { ...target, ...trace });
  } catch (error) {
    getLogger().warn("tool call record write failed", {
      "run.id": target.runId,
      "space.id": target.spaceId,
      tool: trace.tool,
      "error.detail": bounded(String((error as Error)?.message ?? error), 200, secrets),
    });
  }
}

/**
 * A run's kept calls as a bot reads them in history: redacted again with the run's secrets and
 * bounded tighter, so a page of conversation and its calls stays inside one response. A call that
 * succeeded keeps no result head; a failed one keeps the little that says what it returned.
 */
export function historyToolCalls(
  calls: readonly ToolCallRecord[],
  secrets: string[],
): Array<Record<string, unknown>> {
  return calls.map((call) => {
    const failed = call.outcome === "failed";
    return {
      tool: call.tool,
      outcome: call.outcome,
      durationMs: call.durationMs,
      ...(call.arguments === undefined
        ? {}
        : { arguments: bounded(call.arguments, TOOL_CALL_HISTORY_TEXT_MAX_CHARS, secrets) }),
      ...(call.error === undefined
        ? {}
        : { error: bounded(call.error, TOOL_CALL_HISTORY_TEXT_MAX_CHARS, secrets) }),
      ...(call.resultBytes === undefined ? {} : { resultBytes: call.resultBytes }),
      ...(call.resultShortened ? { resultShortened: true } : {}),
      ...(failed && call.resultHead !== undefined
        ? { resultHead: bounded(call.resultHead, 200, secrets) }
        : {}),
    };
  });
}
