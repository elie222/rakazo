import { describe, expect, it } from "vitest";
import { meetingTurnContext } from "./meeting-turn-context.js";

describe("meeting turn context", () => {
  it("preserves bounded, valid UTF-8 on another replica using the same grant", () => {
    const original = meetingTurnContext("emulator-secret");
    const token = original.seal(`${"議".repeat(2_000)}最後`, "meeting-grant");
    const replica = meetingTurnContext("emulator-secret");
    const result = replica.open(token, "meeting-grant");
    expect(result).toMatch(/^議+最後$/u);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1_600);
  });

  it("prevents moving or changing a transcript token", () => {
    const context = meetingTurnContext("emulator-secret");
    const token = context.seal("Fixture dialogue", "original-grant");
    const changed = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(context.open(changed, "original-grant")).toBe("");
    expect(context.open(token, "another-grant")).toBe("");
    expect(meetingTurnContext("rotated-secret").open(token, "original-grant")).toBe("");
  });
});
