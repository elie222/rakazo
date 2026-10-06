const ACTIVE_REFRESH_STATUSES = new Set(["queued", "leased", "running"]);

/** Full snapshot while an active run has no live subscription. */
const ACTIVE_UNSUBSCRIBED_REFRESH_MS = 750;
/**
 * Safety poll while live events already update the same run. A 750 ms full
 * snapshot would lock the thread twice as often without arriving sooner.
 */
const ACTIVE_SUBSCRIBED_REFRESH_MS = 1_500;
const IDLE_REFRESH_MS = 5_000;

export function threadRefreshDelayMs(
  runStatus: string | undefined,
  options?: { liveSubscribed?: boolean },
): number {
  if (!ACTIVE_REFRESH_STATUSES.has(runStatus ?? "")) return IDLE_REFRESH_MS;
  return options?.liveSubscribed ? ACTIVE_SUBSCRIBED_REFRESH_MS : ACTIVE_UNSUBSCRIBED_REFRESH_MS;
}
