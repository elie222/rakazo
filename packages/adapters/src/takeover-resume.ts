export type TakeoverResumeCheckpoint = "takeover" | "takeover-skipped";

/** Shown when desktop tools are gated because the user still holds the screen. */
export const DESKTOP_HELD_FOR_TAKEOVER_MESSAGE =
  "The user has the screen. File and shell tools still work.";

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

export function takeoverContinuePlan(run: { status: string; checkpoint: string | null }): {
  resumeCheckpoint: TakeoverResumeCheckpoint | null;
  heldForTakeover: boolean;
  resumeHeldLease: boolean;
  takeoverResume: ReturnType<typeof takeoverResumeFromRelease> | null;
} {
  const resumeCheckpoint: TakeoverResumeCheckpoint | null =
    run.checkpoint === "takeover" || run.checkpoint === "takeover-skipped" ? run.checkpoint : null;
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
