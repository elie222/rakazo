export type ProactiveDeliveryState = {
  goalEnabled: boolean;
  goalPaused: boolean;
  meaningfulChange: boolean;
  occurrenceDelivered: boolean;
  quietHoursActive: boolean;
  cooldownUntil: number | null;
  remainingMessages: number;
};

/** Callers must reserve delivery atomically after this check; it is not a reservation itself. */
export function decideProactiveDelivery(
  state: ProactiveDeliveryState,
  now: number,
): { action: "deliver" } | { action: "skip" | "defer"; reason: string } {
  if (!state.goalEnabled || state.goalPaused) return { action: "skip", reason: "goal-inactive" };
  if (state.occurrenceDelivered) return { action: "skip", reason: "duplicate" };
  if (!state.meaningfulChange) return { action: "skip", reason: "no-meaningful-change" };
  if (state.quietHoursActive) return { action: "defer", reason: "quiet-hours" };
  if (state.cooldownUntil !== null && state.cooldownUntil > now) {
    return { action: "defer", reason: "cooldown" };
  }
  if (state.remainingMessages <= 0) return { action: "defer", reason: "message-budget" };
  return { action: "deliver" };
}
