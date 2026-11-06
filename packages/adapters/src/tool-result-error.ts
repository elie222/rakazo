export function isFailedToolResult(value: unknown): value is { error: unknown } {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

/**
 * A shell command's result: what it printed and its exit code, null while it still runs. Only
 * a shell result's shape counts, so a connector response that carries an HTTP `code` such as
 * 200 is not read as a command.
 */
export function shellCommandResult(
  result: unknown,
): { stdout: string; stderr: string; code: number | null } | undefined {
  const payload = (result as { details?: unknown } | null)?.details ?? result;
  if (!payload || typeof payload !== "object") return undefined;
  const { stdout, stderr, code } = payload as {
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
  };
  if (typeof stdout !== "string" || typeof stderr !== "string") return undefined;
  if (typeof code !== "number" && code !== null) return undefined;
  return { stdout, stderr, code };
}

function shellExitCode(result: unknown): number | undefined {
  return shellCommandResult(result)?.code ?? undefined;
}

/**
 * Whether a finished call failed: it threw, returned an error, or a shell command exited with
 * a nonzero code. A command still running when its tool returned has no code yet.
 */
export function toolCallFailed(error: unknown, result: unknown): boolean {
  if (error !== undefined || toolResultError(result) !== undefined) return true;
  const code = shellExitCode(result);
  return code !== undefined && code !== 0;
}

/**
 * Tools can return an `error` or MCP `isError: true` instead of throwing. Pi keeps that
 * result in `details` without populating `completion.error`. Read the failure for auditing
 * without changing the result that reaches the model and lets it react to the failure.
 */
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
