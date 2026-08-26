import { describe, expect, it } from "vitest";
import { executionBlocksUserTakeover, toComputerStatus } from "./computer-status.js";

describe("toComputerStatus", () => {
  it("only marks control that is bound to a waiting run as a requested takeover", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlRunId: "run-1",
      homeRevision: "revision-1",
    };

    expect(toComputerStatus("bot-1", computer).takeoverRequested).toBe(true);
    expect(toComputerStatus("bot-1", { ...computer, controlRunId: null }).takeoverRequested).toBe(
      false,
    );
  });

  it("passes through the busy bot name when takeover is blocked", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer).busyBotName).toBeNull();
    expect(toComputerStatus("bot-1", computer, "Writer").busyBotName).toBe("Writer");
  });

  it("hides update on desktop computers", () => {
    expect(
      toComputerStatus("bot-1", {
        kind: "desktop",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).updateAvailable,
    ).toBe(false);
    expect(
      toComputerStatus("bot-1", {
        kind: "e2b",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).updateAvailable,
    ).toBe(true);
  });
});

describe("executionBlocksUserTakeover", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("allows takeover when there is no execution lease", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: false,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(false);
  });

  it("allows takeover while the run is waiting for the user", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "waiting_takeover",
        now,
      }),
    ).toBe(false);
  });

  it("blocks takeover for an active lease or active run", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "completed",
        now,
      }),
    ).toBe(true);
  });

  it("allows takeover when both the lease and run are inactive", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "completed",
        now,
      }),
    ).toBe(false);
  });
});
