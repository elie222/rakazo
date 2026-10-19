import { describe, expect, it } from "vitest";
import { formatCurrentTimeInstruction } from "./current-time.js";

describe("formatCurrentTimeInstruction", () => {
  it("anchors the present moment in UTC with the weekday and no sub-second noise", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-09-17T14:55:41.123Z"));
    expect(line).toContain("Current date and time: Thursday, 2026-09-17T14:55:41Z (UTC).");
    expect(line).not.toContain(".123");
  });

  it("tells the model not to guess the date from training data or quoted timestamps", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-01-01T00:00:00Z"));
    expect(line).toContain("Never infer today's date from your training data");
    expect(line).toContain("write absolute dates");
  });

  it("defaults to the real clock", () => {
    const before = Date.now();
    const line = formatCurrentTimeInstruction();
    const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z/.exec(line);
    expect(match).not.toBeNull();
    const stamped = Date.parse(`${match![1]}Z`);
    expect(Math.abs(stamped - before)).toBeLessThan(5_000);
  });
});
