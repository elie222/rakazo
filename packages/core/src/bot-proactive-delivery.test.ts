import { describe, expect, it } from "vitest";
import { decideProactiveDelivery, type ProactiveDeliveryState } from "./bot-proactive-delivery.js";

const ready: ProactiveDeliveryState = {
  goalEnabled: true,
  goalPaused: false,
  meaningfulChange: true,
  occurrenceDelivered: false,
  quietHoursActive: false,
  cooldownUntil: null,
  remainingMessages: 1,
};

describe("proactive delivery gate", () => {
  it("allows a meaningful enabled occurrence within limits", () => {
    expect(decideProactiveDelivery(ready, 100)).toEqual({ action: "deliver" });
  });
  it.each([
    [{ goalEnabled: false }, "skip", "goal-inactive"],
    [{ goalPaused: true }, "skip", "goal-inactive"],
    [{ occurrenceDelivered: true }, "skip", "duplicate"],
    [{ meaningfulChange: false }, "skip", "no-meaningful-change"],
    [{ quietHoursActive: true }, "defer", "quiet-hours"],
    [{ cooldownUntil: 101 }, "defer", "cooldown"],
    [{ remainingMessages: 0 }, "defer", "message-budget"],
  ] as const)("gates %j", (patch, action, reason) => {
    expect(decideProactiveDelivery({ ...ready, ...patch }, 100)).toEqual({ action, reason });
  });
});
