import { describe, expect, it } from "vitest";
import { localDateTime } from "./ToolQuestionCard";

describe("localDateTime", () => {
  it("shows a default with an offset in the local picker's form", () => {
    expect(localDateTime("2026-11-18T09:30")).toBe("2026-11-18T09:30");
    const utc = new Date("2026-11-18T09:30:00Z");
    const two = (part: number) => String(part).padStart(2, "0");
    expect(localDateTime(utc.toISOString())).toBe(
      `${utc.getFullYear()}-${two(utc.getMonth() + 1)}-${two(utc.getDate())}T${two(utc.getHours())}:${two(utc.getMinutes())}`,
    );
  });

  it("shows a date at the edge of the range, or no date, as empty instead of throwing", () => {
    expect(localDateTime("+275760-09-13T00:00:00.000Z")).toBe("");
    expect(localDateTime("-271821-04-20T00:00:00.000Z")).toBe("");
    expect(localDateTime("not a date")).toBe("");
    expect(localDateTime(undefined)).toBe("");
  });
});
