/** A timeout, dropped connection, cancellation, rate limit or server error from the API. The
 * client sets `status` on every API error and leaves it unset when no response came back. */
export function isComposioOutage(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
  const status = error.status;
  if (status === undefined) return true;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

/** The session named a connected account the provider no longer has for this user. */
export function isStaleConnectedAccountError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; details?: { slug?: unknown } };
  return (
    candidate.status === 400 &&
    candidate.details?.slug === "ToolRouterV2_InvalidConnectedAccountIds"
  );
}

/** The connected account ids a stale-account refusal names. */
export function staleAccountIds(error: unknown): Set<string> {
  const message = (error as { details?: { message?: unknown } }).details?.message;
  return new Set(typeof message === "string" ? (message.match(/\bca_[A-Za-z0-9_-]+/g) ?? []) : []);
}
