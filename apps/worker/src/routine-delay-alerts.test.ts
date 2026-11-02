import { describe, expect, it, vi } from "vitest";
import { sendRoutineDelayAlert, shouldAlertDelayedRoutine } from "./routine-delay-alerts.js";

describe("delayed routine alert episodes", () => {
  const now = new Date("2026-11-01T06:30:00Z");
  const row = {
    active: true,
    delayAlertsEnabled: true,
    nextRunAt: new Date("2026-11-01T06:20:00Z"),
    delayAlertSchedule: null,
    delayAlertClaimedAt: null,
    delayAlertSentAt: null,
    delayAlertResult: null,
  };
  it("requires an enabled, active schedule past its grace period", () => {
    expect(shouldAlertDelayedRoutine(row, now)).toBe(true);
    expect(shouldAlertDelayedRoutine({ ...row, active: false }, now)).toBe(false);
    expect(shouldAlertDelayedRoutine({ ...row, delayAlertsEnabled: false }, now)).toBe(false);
    expect(
      shouldAlertDelayedRoutine({ ...row, nextRunAt: new Date("2026-11-01T07:00:00Z") }, now),
    ).toBe(false);
  });
  it("deduplicates an episode and retries failures only after cooldown", () => {
    const episode = { ...row, delayAlertSchedule: row.nextRunAt, delayAlertClaimedAt: now };
    expect(shouldAlertDelayedRoutine({ ...episode, delayAlertResult: "sent" }, now)).toBe(false);
    expect(shouldAlertDelayedRoutine({ ...episode, delayAlertResult: "failed" }, now)).toBe(false);
    expect(
      shouldAlertDelayedRoutine(
        { ...episode, delayAlertResult: "failed" },
        new Date(now.getTime() + 60 * 60_000),
      ),
    ).toBe(true);
  });
  it("suppresses another episode during cooldown and allows it afterwards", () => {
    const previous = {
      ...row,
      delayAlertSchedule: null,
      delayAlertSentAt: now,
      delayAlertResult: null,
    };
    expect(shouldAlertDelayedRoutine(previous, now)).toBe(false);
    expect(shouldAlertDelayedRoutine(previous, new Date(now.getTime() + 60 * 60_000))).toBe(true);
  });
  it("does not repeat when the next dispatch changes but the schedule remains overdue", () => {
    expect(
      shouldAlertDelayedRoutine(
        {
          ...row,
          delayAlertSchedule: new Date("2026-11-01T05:00:00Z"),
          delayAlertResult: "sent",
          delayAlertSentAt: new Date("2026-11-01T05:05:00Z"),
        },
        now,
      ),
    ).toBe(false);
  });
});

it("claims one delivery across concurrent detectors and records a delivery failure", async () => {
  let claimed = false;
  const updateMany = vi.fn(async (args: { data: { delayAlertResult: string } }) => {
    if (args.data.delayAlertResult === "pending") {
      if (claimed) return { count: 0 };
      claimed = true;
    }
    return { count: 1 };
  });
  const deliver = vi.fn(async () => {
    throw new Error("offline");
  });
  const row = {
    id: "routine-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: "thread-1",
    name: "Report",
    nextRunAt: new Date("2026-11-01T06:00:00Z"),
    delayAlertSchedule: null,
    delayAlertClaimedAt: null,
    delayAlertSentAt: null,
    delayAlertResult: null,
  };
  const db = { routine: { updateMany, findFirst: vi.fn().mockResolvedValue({ id: "routine-1" }) } };
  await Promise.all([
    sendRoutineDelayAlert(db as never, deliver, row, new Date("2026-11-01T06:10:00Z")),
    sendRoutineDelayAlert(db as never, deliver, row, new Date("2026-11-01T06:10:00Z")),
  ]);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ delayAlertResult: "failed" }) }),
  );
});

it("does not send after a pause or schedule change wins the claim race", async () => {
  const db = {
    routine: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const deliver = vi.fn();
  const row = {
    id: "routine-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: "thread-1",
    name: "Report",
    nextRunAt: new Date("2026-11-01T06:00:00Z"),
    delayAlertSchedule: null,
    delayAlertClaimedAt: null,
    delayAlertSentAt: null,
    delayAlertResult: null,
  };
  await sendRoutineDelayAlert(db as never, deliver, row, new Date("2026-11-01T06:10:00Z"));
  expect(deliver).not.toHaveBeenCalled();
});
