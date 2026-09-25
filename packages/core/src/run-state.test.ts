import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isConversationalRun } from "./run-state.js";

describe("run state machine", () => {
  it("allows takeover resume onto a lease", () => {
    expect(canTransition("waiting_takeover", "leased")).toBe(true);
    expect(canTransition("waiting_takeover", "running")).toBe(false);
  });

  it("withholds user steering from routine, webhook, and creation intro turns", () => {
    expect(isConversationalRun("user")).toBe(true);
    expect(isConversationalRun("follow_up")).toBe(true);
    expect(isConversationalRun("messaging")).toBe(true);
    expect(isConversationalRun("routine")).toBe(false);
    expect(isConversationalRun("webhook")).toBe(false);
    expect(isConversationalRun("created")).toBe(false);
  });

  it("rejects rewriting a completed run", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal/i);
  });

  it("never leaves a terminal state except failed retry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("completed" as const, "cancelled" as const),
        fc.constantFrom(
          "queued" as const,
          "leased" as const,
          "running" as const,
          "waiting_input" as const,
          "completed" as const,
        ),
        (from, to) => {
          expect(canTransition(from, to)).toBe(false);
        },
      ),
    );
  });
});
