import type { LogBindings } from "@rakazo/logging";
import { getLogger, runWithLogContext } from "@rakazo/logging";
import { markRequestFailure } from "@rakazo/logging/hono";

/** A command's output can fill an error message, so a log line keeps only this much of it. */
const MAX_LOGGED_CHARS = 500;

function boundedFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_LOGGED_CHARS ? `${message.slice(0, MAX_LOGGED_CHARS)}…` : error;
}

export function logRequestFailure(error: unknown): void {
  markRequestFailure(boundedFailure(error));
}

export function logStreamFailure(
  context: LogBindings,
  route: string,
  method: string,
  error: unknown,
): void {
  runWithLogContext(context, () => {
    getLogger().warn("http.stream.failed", {
      "http.method": method,
      "http.route": route,
      error: boundedFailure(error),
    });
  });
}
