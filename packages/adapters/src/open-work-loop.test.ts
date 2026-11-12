import { describe, expect, it } from "vitest";
import {
  openWorkFingerprint,
  parseOpenWorkLoopCheckpoint,
  serializeOpenWorkLoopCheckpoint,
} from "./open-work-loop.js";

describe("open work loop checkpoint", () => {
  it("round-trips mission state", () => {
    const state = {
      kind: "open_work_loop_v1" as const,
      missionStartedAtMs: 1_700_000_000_000,
      rewakes: 2,
      lastFingerprint: "a|b",
      stallCount: 1,
    };
    expect(parseOpenWorkLoopCheckpoint(serializeOpenWorkLoopCheckpoint(state))).toEqual(state);
  });

  it("fingerprint tracks item updates", () => {
    const first = openWorkFingerprint([
      { id: "a", title: "one", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const second = openWorkFingerprint([
      { id: "a", title: "one", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(first).not.toEqual(second);
  });
});
