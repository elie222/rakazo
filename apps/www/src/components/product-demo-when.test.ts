import { describe, expect, it } from "vitest";
import { demoText } from "../i18n/demo";
import {
  defaultTrigger,
  describeTrigger,
  displayRoutineWhen,
  parseWhen,
  resolveRoutineWhen,
  whenLabel,
} from "./product-demo-when";

describe("resolveRoutineWhen", () => {
  it("preserves opaque seeded schedules through open → save without trigger edits", () => {
    for (const when of ["Tue + Thu", "Last Friday"] as const) {
      const triggers = [parseWhen(when)];
      // parseWhen cannot represent these customs, so whenLabel would rewrite them.
      expect(whenLabel(triggers)).toBe(whenLabel([defaultTrigger()]));
      expect(resolveRoutineWhen(triggers, when)).toBe(when);
    }
  });

  it("serializes triggers once the user changes the schedule", () => {
    const edited = [{ ...defaultTrigger(), freq: "Every hour" }];
    expect(resolveRoutineWhen(edited, "Tue + Thu")).toBe("Every hour");
  });

  it("does not restore a stale opaque when after sourceWhen is cleared", () => {
    // ProductDemo clears sourceWhen on trigger edits; an explicit daily 9:00 AM
    // choice must serialize normally, not snap back to "Tue + Thu".
    const daily = [defaultTrigger()];
    expect(resolveRoutineWhen(daily, undefined)).toBe(whenLabel(daily));
    expect(resolveRoutineWhen(daily, undefined)).not.toBe("Tue + Thu");
  });
});

describe("displayRoutineWhen", () => {
  const zh = (source: string, values?: Record<string, string | number>) =>
    demoText("zh", source, values);

  it("keeps direct Chinese labels for opaque seeded schedules", () => {
    expect(displayRoutineWhen("Tue + Thu", zh)).toBe("周二和周四");
    expect(displayRoutineWhen("Last Friday", zh)).toBe("每月最后一个周五");
  });

  it("keeps opaque English schedules instead of collapsing them to daily 9:00 AM", () => {
    const identity = (source: string) => source;
    expect(displayRoutineWhen("Tue + Thu", identity)).toBe("Tue + Thu");
    expect(displayRoutineWhen("Last Friday", identity)).toBe("Last Friday");
    expect(displayRoutineWhen("Cron 0 9 * * 5", identity)).toBe("Cron 0 9 * * 5");
  });

  it("localizes generated whenLabel schedules via describeTrigger components", () => {
    const stored = whenLabel([defaultTrigger()]);
    expect(stored).toBe("Every day at 9:00 AM");
    expect(displayRoutineWhen(stored, zh)).toBe(
      [
        demoText("zh", "Every day"),
        demoText("zh", "at {time}", { time: demoText("zh", "9:00 AM") }),
      ]
        .filter(Boolean)
        .join(" "),
    );
  });
});

describe("describeTrigger", () => {
  it("localizes the time token for timed schedules", () => {
    const zh = (source: string, values?: Record<string, string | number>) =>
      demoText("zh", source, values);
    const { detail } = describeTrigger(defaultTrigger(), zh);
    expect(detail).toContain(demoText("zh", "9:00 AM"));
    expect(detail).not.toContain("9:00 AM");
  });
});

describe("parseWhen round-trips", () => {
  it("round-trips day intervals and cron labels from whenLabel", () => {
    const everyTwoDays = whenLabel([{ ...defaultTrigger(), freq: "Interval", n: 2, unit: "days" }]);
    expect(everyTwoDays).toBe("Every 2 days");
    expect(whenLabel([parseWhen(everyTwoDays)])).toBe(everyTwoDays);

    const cron = whenLabel([{ ...defaultTrigger(), freq: "Advanced", cron: "0 9 * * 5" }]);
    expect(cron).toBe("Cron 0 9 * * 5");
    expect(whenLabel([parseWhen(cron)])).toBe(cron);
  });
});
