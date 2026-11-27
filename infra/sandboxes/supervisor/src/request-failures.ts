import { markRequestFailure } from "@rakazo/logging/hono";

/** A command's output can fill an error message, so a log line keeps only this much of it. */
const MAX_LOGGED_CHARS = 500;

export function logRequestFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  markRequestFailure(
    message.length > MAX_LOGGED_CHARS ? `${message.slice(0, MAX_LOGGED_CHARS)}…` : error,
  );
}
