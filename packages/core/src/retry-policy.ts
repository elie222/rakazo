/** Longest a server's Retry-After may park a client loop. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** The HTTP status a failed request carried, if it got a response at all. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * Whether asking again can succeed. A failure without a response (the network, a timeout, a
 * dropped stream) can, as can 5xx, 429, and 408. Any other status is the server's answer to this
 * request — signed out, forbidden, gone, or this build no longer supported — and repeating the
 * request only polls the server.
 */
export function isRetryableError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === undefined || status < 400) return true;
  return status >= 500 || status === 429 || status === 408;
}

/** Retry-After as delta-seconds or an HTTP date, in milliseconds from `now`. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/** Wait the server asked for (an error's `retryAfterMs`), otherwise the caller's own backoff. */
export function retryDelayMs(error: unknown, backoffMs: number): number {
  const asked =
    typeof error === "object" && error !== null && "retryAfterMs" in error
      ? error.retryAfterMs
      : undefined;
  return typeof asked === "number" && Number.isFinite(asked) && asked >= 0
    ? Math.min(Math.max(asked, backoffMs), MAX_RETRY_AFTER_MS)
    : backoffMs;
}
