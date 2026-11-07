import { describe, expect, it } from "vitest";
import { chatSnoozed, chatWoke, nextChatWake, snoozePresetTime } from "./chat-snooze.js";

const now = Date.parse("2026-11-07T12:00:00Z");
const later = "2026-11-07T15:00:00.000Z";
const earlier = "2026-11-07T09:00:00.000Z";

describe("chat snooze", () => {
  it("hides a chat until it wakes, then marks it woken", () => {
    expect(chatSnoozed({ snoozedUntil: later }, now)).toBe(true);
    expect(chatWoke({ snoozedUntil: later }, now)).toBe(false);
    expect(chatSnoozed({ snoozedUntil: earlier }, now)).toBe(false);
    expect(chatWoke({ snoozedUntil: earlier }, now)).toBe(true);
    expect(chatSnoozed({ snoozedUntil: null }, now)).toBe(false);
    expect(chatWoke({ snoozedUntil: "not a date" }, now)).toBe(false);
  });


  it("finds the next wake among future snoozes", () => {
    const soon = "2026-11-07T13:00:00.000Z";
    expect(
      nextChatWake(
        [{ snoozedUntil: later }, { snoozedUntil: earlier }, { snoozedUntil: soon }],
        now,
      ),
    ).toBe(Date.parse(soon));
    expect(nextChatWake([{ snoozedUntil: earlier }, {}], now)).toBeNull();
  });

  it("wakes presets at 9 the next morning or the next Monday", () => {
    // Saturday 7 November 2026, 14:30 local.
    const saturday = new Date(2026, 10, 7, 14, 30);
    expect(snoozePresetTime("threeHours", saturday)).toEqual(new Date(2026, 10, 7, 17, 30));
    expect(snoozePresetTime("tomorrow", saturday)).toEqual(new Date(2026, 10, 8, 9));
    expect(snoozePresetTime("nextWeek", saturday)).toEqual(new Date(2026, 10, 9, 9));
    // On a Monday, next week is the following Monday.
    expect(snoozePresetTime("nextWeek", new Date(2026, 10, 9, 8))).toEqual(
      new Date(2026, 10, 16, 9),
    );
  });
});
