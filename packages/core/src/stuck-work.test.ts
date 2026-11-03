import { describe, expect, it } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
  TAKEOVER_WAIT_EXPIRE_AFTER_MS,
} from "./stuck-work.js";

describe("stuck work age", () => {
  it("keeps the reminder well before the cancellation", () => {
    expect(STUCK_WORK_EXPIRE_AFTER_MS).toBeGreaterThan(STUCK_WORK_NOTIFY_AFTER_MS);
  });

  it.each(["queued", "waiting_input"] as const)(
    "stays quiet until the reminder, then cancels at the longer limit (%s)",
    (status) => {
      const action = (ageMs: number, alreadyNotified: boolean) =>
        stuckWorkAction({ status, ageMs, alreadyNotified });
      expect(stuckWorkDueAfterMs(status)).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
      expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS, false)).toBe("none");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS - 1, false)).toBe("none");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS, false)).toBe("notify");
      expect(action(STUCK_WORK_NOTIFY_AFTER_MS, true)).toBe("none");
      expect(action(STUCK_WORK_EXPIRE_AFTER_MS - 1, true)).toBe("none");
      expect(action(STUCK_WORK_EXPIRE_AFTER_MS, true)).toBe("expire");
    },
  );

  it("cancels a takeover nobody acted on after half an hour", () => {
    const action = (ageMs: number) =>
      stuckWorkAction({ status: "waiting_takeover", ageMs, alreadyNotified: false });
    expect(TAKEOVER_WAIT_EXPIRE_AFTER_MS).toBe(30 * 60 * 1000);
    expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(TAKEOVER_WAIT_EXPIRE_AFTER_MS);
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS - 1)).toBe("none");
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS)).toBe("expire");
  });

  it("treats only queued and human waits as stuck", () => {
    expect(isStuckWorkStatus("queued")).toBe(true);
    expect(isStuckWorkStatus("waiting_takeover")).toBe(true);
    expect(isStuckWorkStatus("running")).toBe(false);
    expect(isAgedStuckWork("queued", new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS))).toBe(true);
    expect(isAgedStuckWork("running", new Date(0))).toBe(false);
    expect(isAgedStuckWork("queued", "not-a-date")).toBe(false);
  });

  it("uses a distinct status line and a matching stopped notice", () => {
    const messages = STUCK_WORK_STATUSES_FOR_TEST();
    expect(new Set(messages).size).toBe(messages.length);
    expect(stuckWorkStatusMessage("waiting_takeover")).toMatch(/screen/);
    expect(stuckWorkStoppedNotification("waiting_input", "  ")).toEqual({
      kind: "failure",
      title: "Bot stopped",
      body: stuckWorkStatusMessage("waiting_input"),
    });
    expect(stuckWorkReminder("waiting_takeover", "Ada")).toMatchObject({
      kind: "takeover",
      title: "Ada still needs you",
    });
    expect(stuckWorkReminder("queued", "Ada").kind).toBe("help");
  });
});

function STUCK_WORK_STATUSES_FOR_TEST(): string[] {
  return [...stuckWorkStatusMessages()];
}
