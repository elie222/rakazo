import { describe, expect, it } from "vitest";
import {
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./session-gate.js";

const user = { user: { id: "u_1" } };

describe("session gate", () => {
  it("shows the app once a session resolves", () => {
    expect(sessionGate({ data: user, isPending: false, error: null })).toBe("authenticated");
  });

  it("waits while the first lookup is in flight", () => {
    expect(sessionGate({ data: null, isPending: true, error: null })).toBe("loading");
  });

  it("sends a signed-out visitor to sign-in", () => {
    expect(sessionGate({ data: null, isPending: false, error: null })).toBe("anonymous");
  });

  it("treats 401 as a real sign-out", () => {
    expect(sessionGate({ data: null, isPending: false, error: { status: 401 } })).toBe("anonymous");
  });

  it("does not sign out a cold load that could not reach the server", () => {
    expect(sessionGate({ data: null, isPending: false, error: { status: 503 } })).toBe(
      "unreachable",
    );
    // A thrown fetch has no status at all.
    expect(sessionGate({ data: null, isPending: false, error: {} })).toBe("unreachable");
  });

  it("keeps showing the app when a refresh fails for an established session", () => {
    expect(sessionGate({ data: user, isPending: false, error: { status: 500 } })).toBe(
      "authenticated",
    );
  });

  it("holds the reconnect screen across a null-session refetch", () => {
    expect(holdUnreachableGate("unreachable", false)).toBe(true);
    expect(holdUnreachableGate("loading", true)).toBe(true);
    expect(holdUnreachableGate("authenticated", true)).toBe(false);
    expect(holdUnreachableGate("anonymous", true)).toBe(false);
    expect(showSessionUnavailable("loading", true)).toBe(true);
    expect(showSessionUnavailable("loading", false)).toBe(false);
  });

  it("backs off between retries and stops growing", () => {
    expect(sessionRetryDelayMs(0)).toBe(1_000);
    expect(sessionRetryDelayMs(1)).toBe(2_000);
    expect(sessionRetryDelayMs(3)).toBe(8_000);
    expect(sessionRetryDelayMs(20)).toBe(15_000);
  });
});
