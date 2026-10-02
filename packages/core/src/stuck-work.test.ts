import { describe, expect, it } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
} from "./stuck-work.js";

describe("stuck work age", () => {
  it("keeps the reminder well before the cancellation", () => {
    expect(STUCK_WORK_EXPIRE_AFTER_MS).toBeGreaterThan(STUCK_WORK_NOTIFY_AFTER_MS);
  });

  it("stays quiet until the reminder, then cancels at the longer limit", () => {
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS - 1, alreadyNotified: false })).toBe(
      "none",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS, alreadyNotified: false })).toBe(
      "notify",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_NOTIFY_AFTER_MS, alreadyNotified: true })).toBe(
      "none",
    );
    expect(stuckWorkAction({ ageMs: STUCK_WORK_EXPIRE_AFTER_MS, alreadyNotified: true })).toBe(
      "expire",
    );
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
