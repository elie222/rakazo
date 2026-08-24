import { describe, expect, it } from "vitest";
import {
  type CronPreset,
  cronFromPreset,
  describeCronPreset,
  formatCron,
  nextCronDate,
  presetFromCron,
} from "./cron.js";

function preset(partial: Partial<CronPreset> & Pick<CronPreset, "freq">): CronPreset {
  return {
    n: 3,
    unit: "minutes",
    time: "9:00 AM",
    cron: "",
    ...partial,
  };
}

describe("cronFromPreset", () => {
  it("maps everyday language onto cron", () => {
    expect(cronFromPreset(preset({ freq: "Every day", time: "9:00 AM" }))).toBe("0 9 * * *");
    expect(cronFromPreset(preset({ freq: "Weekdays", time: "8:00 AM" }))).toBe("0 8 * * 1-5");
    expect(cronFromPreset(preset({ freq: "Every week", time: "9:00 AM" }))).toBe("0 9 * * 1");
    expect(cronFromPreset(preset({ freq: "Every month", time: "12:00 PM" }))).toBe("0 12 1 * *");
    expect(cronFromPreset(preset({ freq: "Every hour" }))).toBe("0 * * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "12:00 AM" }))).toBe("0 0 * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "3:00 PM" }))).toBe("0 15 * * *");
  });

  it("maps intervals including days", () => {
    expect(cronFromPreset(preset({ freq: "Interval", n: 15, unit: "minutes" }))).toBe(
      "*/15 * * * *",
    );
    expect(cronFromPreset(preset({ freq: "Interval", n: 2, unit: "hours" }))).toBe("0 */2 * * *");
    expect(cronFromPreset(preset({ freq: "Interval", n: 3, unit: "days" }))).toBe("0 0 */3 * *");
  });

  it("keeps advanced expressions", () => {
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "0 10 15 * *" }))).toBe("0 10 15 * *");
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "" }))).toBe("*/3 * * * *");
  });
});

describe("presetFromCron", () => {
  it("reads the previous Monday-morning default as weekly", () => {
    expect(presetFromCron("0 9 * * 1")).toMatchObject({
      freq: "Every week",
      time: "9:00 AM",
    });
  });

  it("round-trips the named presets", () => {
    const cases: CronPreset[] = [
      preset({ freq: "Every hour" }),
      preset({ freq: "Every day", time: "6:00 PM" }),
      preset({ freq: "Weekdays", time: "7:00 AM" }),
      preset({ freq: "Every week", time: "9:00 AM" }),
      preset({ freq: "Every month", time: "12:00 PM" }),
      preset({ freq: "Interval", n: 10, unit: "minutes" }),
      preset({ freq: "Interval", n: 5, unit: "hours" }),
      preset({ freq: "Interval", n: 2, unit: "days" }),
      preset({ freq: "Advanced", cron: "0 10 15 * *" }),
    ];
    for (const input of cases) {
      const cron = cronFromPreset(input);
      const parsed = presetFromCron(cron);
      expect(parsed.freq).toBe(input.freq);
      if (input.freq === "Interval") {
        expect(parsed.n).toBe(input.n);
        expect(parsed.unit).toBe(input.unit);
      }
      if (["Every day", "Weekdays", "Every week", "Every month"].includes(input.freq)) {
        expect(parsed.time).toBe(input.time);
      }
      if (input.freq === "Advanced") {
        expect(parsed.cron).toBe(input.cron);
      }
    }
  });

  it("falls back to advanced for expressions the picker cannot represent", () => {
    expect(presetFromCron("0 9 * * 0")).toMatchObject({ freq: "Advanced", cron: "0 9 * * 0" });
    expect(presetFromCron("30 14 15 * *")).toMatchObject({
      freq: "Advanced",
      cron: "30 14 15 * *",
    });
  });
});

describe("formatCron", () => {
  it("shows a human schedule instead of the expression", () => {
    expect(formatCron("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
    expect(formatCron("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(formatCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCronPreset(preset({ freq: "Every hour" }))).toEqual({
      lead: "Every hour",
      detail: "",
    });
  });
});

describe("nextCronDate", () => {
  it("returns the next matching time today for a daily cron", () => {
    const from = new Date("2026-08-24T10:30:00.000Z");
    expect(nextCronDate("0 11 * * *", from)).toEqual(new Date("2026-08-24T11:00:00.000Z"));
  });

  it("honors day-of-week instead of matching the same hour tomorrow", () => {
    // Monday 13:52 UTC; the weekly slot is Monday 13:00, so the next fire is
    // the following Monday, not Tuesday.
    const from = new Date("2026-08-24T13:52:00.000Z");
    expect(nextCronDate("0 13 * * 1", from)).toEqual(new Date("2026-08-31T13:00:00.000Z"));
  });

  it("maps cron day 7 to Sunday", () => {
    const from = new Date("2026-08-26T12:00:00.000Z"); // Wednesday
    expect(nextCronDate("0 9 * * 7", from)).toEqual(new Date("2026-08-30T09:00:00.000Z"));
  });

  it("supports day 7 inside composite day expressions", () => {
    const from = new Date("2026-08-26T12:00:00.000Z"); // Wednesday
    // 1,7 = Monday and Sunday -> next is Sunday Aug 30.
    expect(nextCronDate("0 9 * * 1,7", from)).toEqual(new Date("2026-08-30T09:00:00.000Z"));
    // 5-7 = Friday, Saturday, Sunday -> next is Friday Aug 28.
    expect(nextCronDate("0 9 * * 5-7", from)).toEqual(new Date("2026-08-28T09:00:00.000Z"));
  });

  it("evaluates the schedule in the routine timezone", () => {
    // 10:00 UTC is 06:00 in New York on the same day, so a 7 AM America/New_York
    // daily slot still fires later the same UTC day.
    const from = new Date("2026-08-24T10:00:00.000Z");
    expect(nextCronDate("0 7 * * *", from, "America/New_York")).toEqual(
      new Date("2026-08-24T11:00:00.000Z"),
    );
  });

  it("falls back to UTC for an unknown timezone", () => {
    const from = new Date("2026-08-24T10:00:00.000Z");
    expect(nextCronDate("0 7 * * *", from, "Mars/Olympus")).toEqual(
      new Date("2026-08-25T07:00:00.000Z"),
    );
  });
});
