export type GoalWakeState = {
  enabled: boolean;
  paused: boolean;
  expiresAt: number | null;
  dueAt: number;
  lastOccurrenceKey: string | null;
  occurrenceKey: string;
  sourceGeneration: number;
  currentGeneration: number;
  remainingRuns: number;
  activeRuns: number;
  maxConcurrentRuns: number;
  previousFingerprint: string | null;
  fingerprint: string | null;
};

export type GoalWakeDecision =
  | { action: "skip"; reason: string }
  | { action: "baseline"; fingerprint: string }
  | { action: "run" };

/** Checks only recorded facts; free-form goal interpretation belongs to reviewed model policy. */
export function decideGoalWake(state: GoalWakeState, now: number): GoalWakeDecision {
  if (!state.enabled || state.paused) return { action: "skip", reason: "disabled" };
  if (state.expiresAt !== null && state.expiresAt <= now) {
    return { action: "skip", reason: "expired" };
  }
  if (state.dueAt > now) return { action: "skip", reason: "not-due" };
  if (state.sourceGeneration !== state.currentGeneration) {
    return { action: "skip", reason: "stale-generation" };
  }
  if (!state.occurrenceKey || state.occurrenceKey === state.lastOccurrenceKey) {
    return { action: "skip", reason: "duplicate" };
  }
  if (state.remainingRuns <= 0) return { action: "skip", reason: "budget" };
  if (state.maxConcurrentRuns <= 0 || state.activeRuns >= state.maxConcurrentRuns) {
    return { action: "skip", reason: "concurrency" };
  }
  if (state.fingerprint !== null) {
    if (state.previousFingerprint === null) {
      return { action: "baseline", fingerprint: state.fingerprint };
    }
    if (state.fingerprint === state.previousFingerprint) {
      return { action: "skip", reason: "unchanged" };
    }
  }
  return { action: "run" };
}
