import { describe, expect, it } from "vitest";
import { formatCurrentTimeInstruction } from "./current-time.prompt.js";

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

  it("leads with the user's local time when their timezone is known", () => {
    // 09:15 UTC is 22:15 the same day in Auckland during daylight time (UTC+13).
    const line = formatCurrentTimeInstruction(new Date("2026-10-17T09:15:30Z"), "Pacific/Auckland");
    expect(line).toContain(
      "Current date and time for the user: Saturday, 2026-10-17 22:15 (UTC+13:00) (Pacific/Auckland). That is 2026-10-17T09:15:30Z (UTC).",
    );
    expect(line).toContain("Use the user's time zone for times you mention");
  });

  it("uses the local calendar date when it differs from UTC", () => {
    const line = formatCurrentTimeInstruction(new Date("2026-01-01T02:00:00Z"), "America/New_York");
    expect(line).toContain("Wednesday, 2025-12-31 21:00 (UTC-05:00) (America/New_York)");
  });

  it("falls back to UTC for a missing or unknown timezone", () => {
    const at = new Date("2026-09-17T14:55:41Z");
    const utc = "Current date and time: Thursday, 2026-09-17T14:55:41Z (UTC).";
    expect(formatCurrentTimeInstruction(at, null)).toContain(utc);
    expect(formatCurrentTimeInstruction(at, "Not/AZone")).toContain(utc);
  });

  it("does not tell the model to re-judge everything against the anchor", () => {
    expect(formatCurrentTimeInstruction(new Date("2026-09-17T14:55:41Z"))).not.toContain(
      "Treat this as the present moment",
    );
  });

  it("says when the previous message was sent after a pause, in the user's time zone", () => {
    const line = formatCurrentTimeInstruction(
      new Date("2026-11-12T08:54:00Z"),
      "Europe/Athens",
      new Date("2026-11-11T21:42:00Z"),
    );
    expect(line).toContain("Wednesday, 2026-11-11 23:42 (UTC+02:00), 11 hours earlier");
  });

  it("counts long pauses in days and falls back to UTC", () => {
    const line = formatCurrentTimeInstruction(
      new Date("2026-11-12T08:54:00Z"),
      null,
      new Date("2026-11-09T08:00:00Z"),
    );
    expect(line).toContain("Monday, 2026-11-09 08:00 (UTC), 3 days earlier");
  });

  it("says nothing about the previous message within the hour", () => {
    const line = formatCurrentTimeInstruction(
      new Date("2026-11-12T08:54:00Z"),
      "Europe/Athens",
      new Date("2026-11-12T08:00:00Z"),
    );
    expect(line).not.toContain("earlier");
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
