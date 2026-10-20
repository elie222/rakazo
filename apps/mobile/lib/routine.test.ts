import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineRowDetail, routineStatusLine, sortRoutinesByNextRun } from "./routine.js";

function routine(partial: Partial<Routine>): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Weekly review",
    prompt: "Review the week.",
    crons: [],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("routineStatusLine", () => {
  it("names a change trigger", () => {
    expect(
      routineStatusLine(
        routine({ watch: { kind: "files", paths: ["inbox"], everyMinutes: 15, loud: false } }),
      ),
    ).toBe("Active · When something changes · UTC");
  });

  it("shows readable schedules instead of cron expressions", () => {
    expect(routineStatusLine(routine({ crons: ["0 6 * * *"] }))).toBe(
      "Active · Every day at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 6 * * 0"] }))).toBe(
      "Active · Every Sunday at 6:00 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["30 8 * * 1-5"] }))).toBe(
      "Active · Weekdays at 8:30 AM · UTC",
    );
    expect(routineStatusLine(routine({ crons: ["0 * * * *"] }))).toBe("Active · Every hour · UTC");
  });

  it("keeps the routine's time zone and other triggers", () => {
    expect(
      routineStatusLine(
        routine({
          active: false,
          crons: ["0 9 * * 1"],
          timezone: "Europe/Berlin",
          webhookEnabled: true,
        }),
      ),
    ).toBe("Paused · Every Monday at 9:00 AM, Webhook · Europe/Berlin");
  });

  it("omits the trigger segment when there are no triggers", () => {
    expect(routineStatusLine(routine({}))).toBe("Active · UTC");
  });
});

describe("routineRowDetail", () => {
  it("shows the schedule without Active or the device's own time zone", () => {
    expect(routineRowDetail(routine({ crons: ["30 8 * * 1-5"] }), "UTC")).toBe(
      "Weekdays at 8:30 AM",
    );
  });

  it("joins several triggers and names a time zone other than the device's", () => {
    expect(
      routineRowDetail(
        routine({
          crons: ["0 6 * * *", "0 9 * * 1"],
          timezone: "Europe/Berlin",
          webhookEnabled: true,
        }),
        "America/New_York",
      ),
    ).toBe("Every day at 6:00 AM, Every Monday at 9:00 AM, Webhook · Europe/Berlin");
  });

  it("ends with Paused only when paused", () => {
    expect(routineRowDetail(routine({ active: false, crons: ["0 * * * *"] }), "UTC")).toBe(
      "Every hour · Paused",
    );
    expect(routineRowDetail(routine({ active: false, timezone: "Asia/Tokyo" }), "UTC")).toBe(
      "Asia/Tokyo · Paused",
    );
  });

  it("keeps the time zone when the device's is unknown", () => {
    expect(routineRowDetail(routine({ crons: ["0 6 * * *"] }), undefined)).toBe(
      "Every day at 6:00 AM · UTC",
    );
  });
});

describe("sortRoutinesByNextRun", () => {
  it("puts the soonest run first, then routines without one, oldest first on ties", () => {
    const sorted = sortRoutinesByNextRun([
      routine({ id: "none-new", createdAt: "2026-03-01T00:00:00.000Z" }),
      routine({ id: "later", nextRunAt: "2026-10-20T09:00:00.000Z" }),
      routine({ id: "none-old", createdAt: "2026-02-01T00:00:00.000Z" }),
      routine({
        id: "soon-new",
        nextRunAt: "2026-10-19T09:00:00.000Z",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
      routine({
        id: "soon-old",
        nextRunAt: "2026-10-19T09:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([
      "soon-old",
      "soon-new",
      "later",
      "none-old",
      "none-new",
    ]);
  });
});
