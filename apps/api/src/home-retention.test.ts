import { describe, expect, it } from "vitest";
import { homeDeletionDue } from "./home-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY);
const now = at(200);
const billing = (fields: Record<string, unknown> = {}) => ({
  status: null,
  subscribedAt: null,
  endedAt: null,
  currentPeriodEndsAt: null,
  updatedAt: at(0),
  ...fields,
});
const credits = (fields: Record<string, unknown> = {}) => ({
  mode: "credits",
  balanceMicros: 0n,
  byokFreeUntil: null,
  ...fields,
});

describe("saved home deletion date", () => {
  it("never deletes while a plan is live or waiting on payment", () => {
    for (const status of ["trialing", "active", "past_due", "unpaid", "paused"])
      expect(
        homeDeletionDue(
          { billing: billing({ status, subscribedAt: at(0) }), modelCredits: null },
          at(0),
          now,
        ),
      ).toBeNull();
  });

  it("never deletes while the organization can still run bots on credits or a free period", () => {
    const canceled = billing({ status: "canceled", subscribedAt: at(0), endedAt: at(10) });
    expect(
      homeDeletionDue(
        { billing: canceled, modelCredits: credits({ balanceMicros: 1n }) },
        at(0),
        now,
      ),
    ).toBeNull();
    expect(
      homeDeletionDue(
        { billing: canceled, modelCredits: credits({ mode: "byok", byokFreeUntil: at(201) }) },
        at(0),
        now,
      ),
    ).toBeNull();
  });

  it("gives an ended plan 30 days from its end or its last use, whichever is later", () => {
    const ended = {
      billing: billing({ status: "canceled", subscribedAt: at(0), endedAt: at(100) }),
      modelCredits: credits(),
    };
    expect(homeDeletionDue(ended, at(50), now)).toEqual({ at: at(130), reason: "plan-ended" });
    expect(homeDeletionDue(ended, at(110), now)).toEqual({ at: at(140), reason: "plan-ended" });
  });

  it("gives a computer without a paid plan 90 days from its last use", () => {
    expect(homeDeletionDue({ billing: null, modelCredits: null }, at(10), now)).toEqual({
      at: at(100),
      reason: "unused",
    });
    expect(homeDeletionDue({ billing: billing(), modelCredits: null }, at(10), now)).toEqual({
      at: at(100),
      reason: "unused",
    });
  });
});
