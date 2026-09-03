const ACTIVE_REFRESH_STATUSES = new Set(["queued", "leased", "running"]);

export function threadRefreshDelayMs(runStatus: string | undefined): number {
  return ACTIVE_REFRESH_STATUSES.has(runStatus ?? "") ? 1_500 : 5_000;
}
