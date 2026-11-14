import { describe, expect, it, vi } from "vitest";
import { createRosterSignals, OPENING_SIGNAL_GRACE_MS } from "./roster-signals";

function signals() {
  let now = 0;
  const refresh = vi.fn();
  const roster = createRosterSignals(refresh, () => now);
  return {
    refresh,
    roster,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createRosterSignals", () => {
  it("skips the opening signal that arrives with the page's own first load", () => {
    const { refresh, roster } = signals();
    roster.changed();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-reads on a late opening signal, since the page's own load may be stale by then", () => {
    const { refresh, roster, advance } = signals();
    advance(OPENING_SIGNAL_GRACE_MS);
    roster.changed();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("re-reads on the opening signal when the page's own first load failed", () => {
    const { refresh, roster } = signals();
    roster.firstLoadFailed();
    roster.changed();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("re-reads on each later signal, including the one a reconnect opens with", () => {
    const { refresh, roster, advance } = signals();
    roster.changed();
    roster.changed();
    expect(refresh).toHaveBeenCalledOnce();
    advance(1_000);
    // The stream dropped and reconnected: its opening signal is the catch-up.
    roster.changed();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
