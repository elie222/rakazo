import { describe, expect, it, vi } from "vitest";
import { createRosterSignals } from "./roster-signals";

describe("createRosterSignals", () => {
  it("holds a signal that arrives during the first load until that load settles", () => {
    const refresh = vi.fn();
    const roster = createRosterSignals(refresh);
    roster.changed();
    roster.changed();
    expect(refresh).not.toHaveBeenCalled();
    roster.firstLoadSettled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("re-reads nothing extra when no signal came during the first load", () => {
    const refresh = vi.fn();
    const roster = createRosterSignals(refresh);
    roster.firstLoadSettled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-reads on each later signal, including the one a reconnect opens with", () => {
    const refresh = vi.fn();
    const roster = createRosterSignals(refresh);
    roster.firstLoadSettled();
    roster.changed();
    // The stream dropped and reconnected: its opening signal is the catch-up.
    roster.changed();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
