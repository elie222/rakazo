import { describe, expect, it } from "vitest";
import {
  defaultTrigger,
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
