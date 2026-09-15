import { describe, expect, it } from "vitest";
import {
  continueRunClaimFence,
  refreshTakeoverContinuePlan,
  takeoverContinuePlan,
  takeoverResumeFromRelease,
} from "./takeover-resume.js";

describe("takeoverResumeFromRelease", () => {
  it("tells the bot the login finished after I'm done or a plain release", () => {
    for (const reason of ["done", "released", undefined]) {
      const resume = takeoverResumeFromRelease(reason);
      expect(resume.checkpoint).toBe("takeover");
      expect(resume.promptNote).toMatch(/finished the login/i);
    }
  });

  it("tells the bot the login was skipped", () => {
    const resume = takeoverResumeFromRelease("skipped");
    expect(resume.checkpoint).toBe("takeover-skipped");
    expect(resume.promptNote).toMatch(/skipped the login/i);
    expect(resume.promptNote).not.toMatch(/finished the login/i);
  });

  it("treats an expired takeover like a skip", () => {
    expect(takeoverResumeFromRelease("expired").checkpoint).toBe("takeover-skipped");
  });
});

describe("takeoverContinuePlan", () => {
  it("keeps a waiting takeover held without treating login as finished", () => {
    const plan = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(plan.heldForTakeover).toBe(true);
    expect(plan.resumeHeldLease).toBe(true);
    expect(plan.resumeCheckpoint).toBeNull();
    expect(plan.takeoverResume).toBeNull();
  });

  it("resumes after a finished or skipped takeover from the release checkpoint", () => {
    const done = takeoverContinuePlan({ status: "queued", checkpoint: "takeover" });
    expect(done.heldForTakeover).toBe(false);
    expect(done.resumeHeldLease).toBe(true);
    expect(done.takeoverResume?.checkpoint).toBe("takeover");

    const skipped = takeoverContinuePlan({
      status: "queued",
      checkpoint: "takeover-skipped",
    });
    expect(skipped.heldForTakeover).toBe(false);
    expect(skipped.takeoverResume?.checkpoint).toBe("takeover-skipped");
  });

  it("does not treat a normal continue as a takeover resume", () => {
    expect(takeoverContinuePlan({ status: "queued", checkpoint: null })).toEqual({
      resumeCheckpoint: null,
      heldForTakeover: false,
      resumeHeldLease: false,
      takeoverResume: null,
    });
  });
});

describe("continueRunClaimFence", () => {
  it("pins the claim to the observed status and checkpoint", () => {
    expect(continueRunClaimFence({ status: "waiting_takeover", checkpoint: null })).toEqual({
      status: "waiting_takeover",
      checkpoint: null,
    });
    expect(continueRunClaimFence({ status: "queued", checkpoint: "takeover" })).toEqual({
      status: "queued",
      checkpoint: "takeover",
    });
  });
});

describe("refreshTakeoverContinuePlan", () => {
  it("ends the held gate when release stamps a checkpoint on the running run", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    const released = refreshTakeoverContinuePlan(held, {
      status: "running",
      checkpoint: "takeover",
    });
    expect(released.heldForTakeover).toBe(false);
    expect(released.resumeCheckpoint).toBe("takeover");
    expect(released.takeoverResume?.checkpoint).toBe("takeover");
  });

  it("keeps the hold when no release checkpoint is present", () => {
    const held = takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null });
    expect(refreshTakeoverContinuePlan(held, { status: "running", checkpoint: null })).toBe(held);
  });
});
