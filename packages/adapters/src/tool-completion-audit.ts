import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";

function isAuditableToolResult(value: unknown): value is {
  kind: "agent_tool_result";
  content: unknown[];
  details: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "agent_tool_result" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * Tools can return an `error` or MCP `isError: true` instead of throwing. Pi keeps that
 * result in `details` without populating `completion.error`. Read the failure for auditing
 * without changing the result that reaches the model and lets it react to the failure.
 */
function toolResultError(result: unknown): unknown {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if (isFailedToolResult(payload)) {
    const message = (payload.error as { message?: unknown })?.message;
    return typeof message === "string" ? message : payload.error;
  }
  if (!payload || typeof payload !== "object") return undefined;
  if ((payload as { isError?: unknown }).isError !== true) return undefined;
  const content = (payload as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (part as { text?: unknown } | null)?.text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .trim()
    : "";
  return text || "tool reported an error result";
}

export function toolCompletionFromResult(
  base: Pick<AgentToolCompletion, "name" | "executionId" | "durationMs">,
  result: unknown,
): AgentToolCompletion {
  const paused = isToolPauseResult(result);
  if (isFailedToolResult(result)) return { ...base, error: result.error, paused };
  return { ...base, result, paused };
}

export function toolCompletionAuditPayload(
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Record<string, unknown> {
  const durationMs = Number.isFinite(completion.durationMs)
    ? Math.max(0, Math.round(completion.durationMs))
    : 0;
  const error =
    completion.error === undefined ? toolResultError(completion.result) : completion.error;
  const payload: Record<string, unknown> = {
    name: redactSecrets(completion.name, secrets),
    executionId: redactSecrets(completion.executionId, secrets),
    durationMs,
    outcome: completion.paused ? "paused" : error === undefined ? "succeeded" : "error",
  };
  if (error !== undefined) {
    payload.error = sanitizeConnectorError(error, secrets);
  }
  if (!isAuditableToolResult(completion.result)) return payload;

  payload.contentTypes = completion.result.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const type = (part as { type?: unknown }).type;
    return type === "text" || type === "image" ? [type] : [];
  });
  const details = completion.result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return payload;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.frameId === "string") {
    payload.frameId = redactSecrets(record.frameId, secrets);
  }
  if (typeof record.capturedAt === "string") {
    payload.capturedAt = record.capturedAt;
  }
  if (typeof record.width === "number" && Number.isFinite(record.width)) {
    payload.width = record.width;
  }
  if (typeof record.height === "number" && Number.isFinite(record.height)) {
    payload.height = record.height;
  }
  return payload;
}

export async function appendToolCompletionAudit(
  deps: { events: Pick<ThreadEvents, "append"> },
  target: { spaceId: string; threadId: string; botId: string; runId: string },
  completion: AgentToolCompletion,
  secrets: string[] = [],
): Promise<void> {
  try {
    await deps.events.append({
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: target.runId,
      type: "agent.tool.completed",
      payload: toolCompletionAuditPayload(completion, secrets),
    });
  } catch (error) {
    // A tool that finishes after its run was cancelled has no history to join.
    if (error instanceof RunHistoryWriteError) return;
    // Audit persistence must not change the tool result or strand the run.
    getLogger().warn("agent tool completion audit append failed", {
      "error.detail": sanitizeConnectorError(error, secrets),
      tool: redactSecrets(completion.name, secrets),
      executionId: redactSecrets(completion.executionId, secrets),
    });
  }
}
