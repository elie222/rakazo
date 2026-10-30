import { describe, expect, it } from "vitest";
import { decideGoalWake, type GoalWakeState } from "./bot-goal-wake.js";

const ready: GoalWakeState = {
  enabled: true,
  paused: false,
  expiresAt: null,
  dueAt: 100,
  lastOccurrenceKey: null,
  occurrenceKey: "goal:1:100",
  sourceGeneration: 1,
  currentGeneration: 1,
  remainingRuns: 2,
  activeRuns: 0,
  maxConcurrentRuns: 1,
  previousFingerprint: null,
  fingerprint: null,
};

describe("bounded goal wake", () => {
  it("admits a due occurrence with remaining limits", () => {
    expect(decideGoalWake(ready, 100)).toEqual({ action: "run" });
  });

  it.each([
    [{ enabled: false }, "disabled"],
    [{ paused: true }, "disabled"],
    [{ expiresAt: 100 }, "expired"],
    [{ dueAt: 101 }, "not-due"],
    [{ currentGeneration: 2 }, "stale-generation"],
    [{ lastOccurrenceKey: ready.occurrenceKey }, "duplicate"],
    [{ occurrenceKey: "" }, "duplicate"],
    [{ remainingRuns: 0 }, "budget"],
    [{ activeRuns: 1 }, "concurrency"],
    [{ maxConcurrentRuns: 0 }, "concurrency"],
  ] as const)("skips ineligible state %j", (patch, reason) => {
    expect(decideGoalWake({ ...ready, ...patch }, 100)).toEqual({ action: "skip", reason });
  });

  it("establishes a watch baseline without running a model", () => {
    expect(decideGoalWake({ ...ready, fingerprint: "first" }, 100)).toEqual({
      action: "baseline",
      fingerprint: "first",
    });
  });

  it("skips unchanged observations but admits changed observations", () => {
    expect(decideGoalWake({ ...ready, fingerprint: "a", previousFingerprint: "a" }, 100)).toEqual({
      action: "skip",
      reason: "unchanged",
    });
    expect(decideGoalWake({ ...ready, fingerprint: "b", previousFingerprint: "a" }, 100)).toEqual({
      action: "run",
    });
  });
});
