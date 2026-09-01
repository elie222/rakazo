import { describe, expect, it } from "vitest";
import { formatDurationMs, toolActivityLabel } from "./duration.js";

describe("tool activity duration", () => {
  it.each([
    [0, "0s"],
    [42_400, "42s"],
    [103_000, "1m 43s"],
    [3_723_000, "1h 2m 3s"],
  ])("formats %i milliseconds as %s", (durationMs, expected) => {
    expect(formatDurationMs(durationMs)).toBe(expected);
  });

  it("keeps live and legacy labels sensible", () => {
    expect(toolActivityLabel(undefined, true)).toBe("Working…");
    expect(toolActivityLabel(undefined, false)).toBe("Worked");
    expect(toolActivityLabel(103_000, false)).toBe("Worked for 1m 43s");
  });
});
