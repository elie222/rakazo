const ACTIVE_REFRESH_STATUSES = new Set(["queued", "leased", "running"]);

/** Full snapshot while an active run has no live subscription. */
const ACTIVE_UNSUBSCRIBED_REFRESH_MS = 10_000;
/**
 * Safety poll while live events already update the same run. SSE carries
 * every message and progress delta, so the snapshot is only a gap detector.
 */
const ACTIVE_SUBSCRIBED_REFRESH_MS = 30_000;
const IDLE_REFRESH_MS = 60_000;
/** Read-only threads have no SSE, so their snapshot is the live path. */
const READ_ONLY_ACTIVE_REFRESH_MS = 750;
const READ_ONLY_IDLE_REFRESH_MS = 5_000;

export function threadRefreshDelayMs(
  runStatus: string | undefined,
  options?: { liveSubscribed?: boolean; readOnly?: boolean },
): number {
  if (options?.readOnly) {
    return ACTIVE_REFRESH_STATUSES.has(runStatus ?? "")
      ? READ_ONLY_ACTIVE_REFRESH_MS
      : READ_ONLY_IDLE_REFRESH_MS;
  }
  if (!ACTIVE_REFRESH_STATUSES.has(runStatus ?? "")) return IDLE_REFRESH_MS;
  return options?.liveSubscribed ? ACTIVE_SUBSCRIBED_REFRESH_MS : ACTIVE_UNSUBSCRIBED_REFRESH_MS;
}
