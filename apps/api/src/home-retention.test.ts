import { describe, expect, it } from "vitest";
import { homeDeletionDue } from "./home-retention.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY);
const account = (fields: Partial<Parameters<typeof homeDeletionDue>[0] & object> = {}) => ({
  status: null,
  subscribedAt: null,
  endedAt: null,
  currentPeriodEndsAt: null,
  updatedAt: at(0),
  ...fields,
});

describe("saved home deletion date", () => {
  it("never deletes while a plan is live or waiting on payment", () => {
    for (const status of ["trialing", "active", "past_due", "unpaid", "paused"])
      expect(homeDeletionDue(account({ status, subscribedAt: at(0) }), at(0))).toBeNull();
  });

  it("gives an ended plan 30 days from its end or its last use, whichever is later", () => {
    const ended = account({ status: "canceled", subscribedAt: at(0), endedAt: at(100) });
    expect(homeDeletionDue(ended, at(50))).toEqual({ at: at(130), reason: "plan-ended" });
    expect(homeDeletionDue(ended, at(110))).toEqual({ at: at(140), reason: "plan-ended" });
  });

  it("gives a computer without a paid plan 90 days from its last use", () => {
    expect(homeDeletionDue(null, at(10))).toEqual({ at: at(100), reason: "unused" });
    expect(homeDeletionDue(account(), at(10))).toEqual({ at: at(100), reason: "unused" });
  });
});
