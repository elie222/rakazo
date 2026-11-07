import type { Routine } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { routineRowDetail, routineTriggerRows } from "./routine.js";

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
    emailSenders: null,
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

describe("routineTriggerRows", () => {
  it("shows readable schedules, then the other triggers", () => {
    expect(
      routineTriggerRows(
        routine({
          crons: ["0 6 * * 0", "30 8 * * 1-5"],
          webhookEnabled: true,
          watch: { kind: "files", paths: ["inbox"], everyMinutes: 15, loud: false },
        }),
        "UTC",
      ),
    ).toEqual([
      "Every Sunday at 6:00 AM",
      "Weekdays at 8:30 AM",
      "Webhook",
      "When something changes",
    ]);
  });

  it("names the routine's zone on schedules when it isn't the device's", () => {
    expect(
      routineTriggerRows(routine({ crons: ["0 9 * * 1"], timezone: "Europe/Berlin" }), "UTC"),
    ).toEqual(["Every Monday at 9:00 AM (Europe/Berlin)"]);
  });

  it("uses the server's delay status, without diagnosing worker health", () => {
    expect(routineRowDetail(routine({ scheduleDelayed: true }), "UTC")).toBe("Schedule delayed");
    expect(routineRowDetail(routine({ active: false, scheduleDelayed: true }), "UTC")).toBe(
      "Paused",
    );
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
    ).toBe("Every day at 6:00 AM, Every Monday at 9:00 AM, Webhook (Europe/Berlin)");
  });

  it("ends with Paused only when paused", () => {
    expect(routineRowDetail(routine({ active: false, crons: ["0 * * * *"] }), "UTC")).toBe(
      "Every hour, Paused",
    );
    expect(routineRowDetail(routine({ active: false, timezone: "Asia/Tokyo" }), "UTC")).toBe(
      "Asia/Tokyo, Paused",
    );
  });

  it("keeps the time zone when the device's is unknown", () => {
    expect(routineRowDetail(routine({ crons: ["0 6 * * *"] }), undefined)).toBe(
      "Every day at 6:00 AM (UTC)",
    );
  });
});
