const SUBSCRIBE_RETRY_BASE_MS = 250;
const SUBSCRIBE_RETRY_MAX_MS = 5_000;

/** Backoff after a dropped SSE subscribe, matching the web shell. */
export function subscribeRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  return Math.min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_BASE_MS * 2 ** exponent);
}
