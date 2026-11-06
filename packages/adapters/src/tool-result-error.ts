export function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * Tools can return an `error` or MCP `isError: true` instead of throwing. Pi keeps that
 * result in `details` without populating `completion.error`. Read the failure for auditing
 * without changing the result that reaches the model and lets it react to the failure.
 */
/**
 * Whether a finished call failed: it threw, returned an error, or a shell command exited with
 * a nonzero code. A command still running when its tool returned has no code yet.
 */
export function toolCallFailed(error: unknown, result: unknown): boolean {
  if (error !== undefined || toolResultError(result) !== undefined) return true;
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  const code = (payload as { code?: unknown } | null)?.code;
  return typeof code === "number" && code !== 0;
}

export function toolResultError(result: unknown): unknown {
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
