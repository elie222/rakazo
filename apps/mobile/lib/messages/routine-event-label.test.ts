import { beforeEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "../i18n/i18n";
import { openWorkEventLabel, routineEventLabel } from "./routine-event-label";

describe("routineEventLabel", () => {
  beforeEach(() => resetI18nForTests("en"));

  it("says what happened to the named routine", () => {
    const label = (change: Parameters<typeof routineEventLabel>[0]["change"]) =>
      routineEventLabel({ kind: "routine_event", change, name: "Morning joke" });
    expect(label("created")).toBe('Created routine "Morning joke"');
    expect(label("updated")).toBe('Updated routine "Morning joke"');
    expect(label("enabled")).toBe('Enabled routine "Morning joke"');
    expect(label("disabled")).toBe('Disabled routine "Morning joke"');
    expect(label("deleted")).toBe('Deleted routine "Morning joke"');
  });

  it("names the item added to open work", () => {
    expect(
      openWorkEventLabel({ kind: "open_work_event", itemId: "item-1", title: "Compare vendors" }),
    ).toBe('Added to open work "Compare vendors"');
  });
});
