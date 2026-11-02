// Matches the delay definition proposed in upstream PR #2324.
export const ROUTINE_DELAY_GRACE_MS = 5 * 60_000;

export function routineScheduleDelay(active: boolean, nextRunAt: Date | null, now: Date): boolean {
  return (
    active && nextRunAt !== null && now.getTime() - nextRunAt.getTime() > ROUTINE_DELAY_GRACE_MS
  );
}
