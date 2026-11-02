import type { RunActivityRow } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  notificationActivity,
  notificationAttention,
  notificationAttentionRuns,
} from "./notification-attention.js";

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

it("shares activity sections and suppresses only rows represented in the visible roster", () => {
  const row = (
    runId: string,
    botId: string,
    status: RunActivityRow["status"],
    groupId: string | null = null,
  ) =>
    ({
      runId,
      botId,
      status,
      groupId,
      threadId: groupId ?? botId,
      updatedAt: "2026-01-01T00:00:00Z",
    }) as RunActivityRow;
  const ask = row("ask", "question", "waiting_input");
  const work = row("work", "busy", "running", "working-group");
  const recent = [
    row("busy-reply", "busy", "completed"),
    row("writer-reply", "writer", "completed"),
    row("group-reply", "busy", "completed", "working-group"),
    row("read", "read", "completed"),
  ];
  const bots = [
    { id: "question", status: "waiting_input", unread: false },
    { id: "orphan", status: "waiting_input", unread: false },
    { id: "busy", status: "running", unread: true },
    { id: "writer", status: "idle", unread: true },
    {
      id: "group-agent",
      status: "waiting_input",
      unread: false,
      threadId: "private",
      activeRunThreadId: "group-thread",
    },
  ];
  const groups = [
    { id: "working-group", unread: true },
    { id: "unread-group", unread: true },
  ];
  const sections = notificationActivity([ask, work], recent, bots, groups);
  expect(sections.attentionRuns.map((run) => run.runId)).toEqual(["ask"]);
  expect(sections.workingRuns.map((run) => run.runId)).toEqual(["work"]);
  expect(sections.attentionBots.map((bot) => bot.id)).toEqual(["orphan"]);
  expect(sections.unreadBots.map((bot) => bot.id)).toEqual(["writer"]);
  expect(sections.unreadGroups.map((group) => group.id)).toEqual(["unread-group"]);
  expect(sections.readRecent.map((run) => run.runId)).toEqual([
    "busy-reply",
    "group-reply",
    "read",
  ]);
  const filtered = notificationActivity([ask, work], recent, bots, groups, {
    active: [],
    recent: [recent[1]!],
    bots: [],
    groups: [],
  });
  expect(filtered.readRecent.map((run) => run.runId)).toEqual(["writer-reply"]);
  expect(filtered.unreadBots).toEqual([]);
});
