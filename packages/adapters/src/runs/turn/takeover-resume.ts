import { takeoverResumeFromRelease } from "./takeover-resume.prompt.js";

export type TakeoverResumeCheckpoint = "takeover" | "takeover-skipped";

export const TAKEOVER_RESUME_CHECKPOINTS: readonly TakeoverResumeCheckpoint[] = [
  "takeover",
  "takeover-skipped",
];

export function takeoverCheckpointOf(
  checkpoint: string | null | undefined,
): TakeoverResumeCheckpoint | null {
  return checkpoint === "takeover" || checkpoint === "takeover-skipped" ? checkpoint : null;
}

export type TakeoverContinuePlan = {
  resumeCheckpoint: TakeoverResumeCheckpoint | null;
  heldForTakeover: boolean;
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
