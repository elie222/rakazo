import type { RunActivityRow } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { notificationAttention, notificationAttentionRuns } from "./notification-attention.js";

it.each([
  ["waiting_input", true, "needs_attention"],
  ["waiting_takeover", false, "needs_attention"],
  ["failed", true, "needs_attention"],
  ["failed", false, null],
  ["running", true, "working"],
  ["queued", false, "working"],
  ["leased", false, "working"],
  ["completed", true, "unread"],
  ["cancelled", false, null],
  ["idle", true, "unread"],
] as const)("classifies %s without confusing work and unread receipts", (status, unread, state) => {
  expect(notificationAttention(status, unread)).toBe(state);
});

it("uses the roster's last failure without masking newly running work", () => {
  expect(notificationAttention("idle", true, true)).toBe("needs_attention");
  expect(notificationAttention("idle", false, true)).toBeNull();
  expect(notificationAttention("running", true, true)).toBe("working");
});

it("only treats the current unread failure as attention while preserving active questions", () => {
  const old = {
    runId: "old",
    botId: "agent",
    threadId: "private",
    status: "failed",
    updatedAt: "2026-01-01T00:00:00Z",
  } as RunActivityRow;
  const current = { ...old, runId: "current", updatedAt: "2026-01-02T00:00:00Z" };
  const bots = [{ id: "agent", unread: true, runErrorId: "current" }];
  expect(notificationAttentionRuns([], [current, old], bots, []).map((run) => run.runId)).toEqual([
    "current",
  ]);
  expect(
    notificationAttentionRuns([], [current, old], [{ ...bots[0]!, unread: false }], []),
  ).toEqual([]);
  const waiting = { ...current, runId: "ask", status: "waiting_input" as const };
  expect(notificationAttentionRuns([waiting], [old], [], [])).toEqual([waiting]);
});
it("does not promote group history after a newer completed or active run, including when input is unsorted", () => {
  const failure = {
    runId: "failed",
    botId: "agent",
    threadId: "group-thread",
    groupId: "group",
    status: "failed",
    updatedAt: "2026-01-01T00:00:00Z",
  } as RunActivityRow;
  const latest = {
    ...failure,
    runId: "latest",
    status: "completed" as const,
    updatedAt: "2026-01-02T00:00:00Z",
  };
  const groups = [{ id: "group", unread: true }];
  expect(notificationAttentionRuns([], [failure, latest], [], groups)).toEqual([]);
  expect(
    notificationAttentionRuns([{ ...latest, status: "running" }], [failure], [], groups),
  ).toEqual([]);
  expect(notificationAttentionRuns([], [failure], [], groups)).toEqual([failure]);
  expect(notificationAttentionRuns([], [failure], [], [{ id: "group", unread: false }])).toEqual(
    [],
  );
});
