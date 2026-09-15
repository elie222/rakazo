export type TakeoverResumeCheckpoint = "takeover" | "takeover-skipped";

export const TAKEOVER_RESUME_CHECKPOINTS: readonly TakeoverResumeCheckpoint[] = [
  "takeover",
  "takeover-skipped",
];

/** Shown when desktop tools are gated because the user still holds the screen. */
export const DESKTOP_HELD_FOR_TAKEOVER_MESSAGE =
  "The user has the screen. File and shell tools still work.";

export function takeoverCheckpointOf(
  checkpoint: string | null | undefined,
): TakeoverResumeCheckpoint | null {
  return checkpoint === "takeover" || checkpoint === "takeover-skipped" ? checkpoint : null;
}

export function takeoverResumeFromRelease(reason: unknown): {
  checkpoint: TakeoverResumeCheckpoint;
  promptNote: string;
} {
  if (reason === "skipped" || reason === "expired") {
    return {
      checkpoint: "takeover-skipped",
      promptNote:
        "The user skipped the login. Continue without treating the login as complete. Do not request takeover again unless you still cannot proceed.",
    };
  }
  return {
    checkpoint: "takeover",
    promptNote:
      "The user finished the login. Continue from where you left off. Do not request takeover again.",
  };
}

export type TakeoverContinuePlan = {
  resumeCheckpoint: TakeoverResumeCheckpoint | null;
  heldForTakeover: boolean;
  resumeHeldLease: boolean;
  takeoverResume: ReturnType<typeof takeoverResumeFromRelease> | null;
};

export function takeoverContinuePlan(run: {
  status: string;
  checkpoint: string | null;
}): TakeoverContinuePlan {
  const resumeCheckpoint = takeoverCheckpointOf(run.checkpoint);
  const heldForTakeover = run.status === "waiting_takeover" && !resumeCheckpoint;
  return {
    resumeCheckpoint,
    heldForTakeover,
    resumeHeldLease: heldForTakeover || Boolean(resumeCheckpoint),
    takeoverResume: resumeCheckpoint
      ? takeoverResumeFromRelease(resumeCheckpoint === "takeover-skipped" ? "skipped" : "done")
      : null,
  };
}

/** Observed status and checkpoint so a concurrent release cannot be claimed away. */
export function continueRunClaimFence(run: { status: string; checkpoint: string | null }) {
  return {
    status: run.status,
    checkpoint: run.checkpoint,
  };
}

/** If release stamped a checkpoint while this continue was held, rebuild the plan from it. */
export function refreshTakeoverContinuePlan(
  plan: TakeoverContinuePlan,
  current: { status: string; checkpoint: string | null },
): TakeoverContinuePlan {
  if (!plan.heldForTakeover) return plan;
  if (!takeoverCheckpointOf(current.checkpoint)) return plan;
  return takeoverContinuePlan(current);
}
