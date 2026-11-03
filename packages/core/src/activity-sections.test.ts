import type { RunStatus } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { activityAttention, activitySections } from "./activity-sections.js";

it.each([
  ["waiting_input", false, false, "needs_attention"],
  ["waiting_takeover", false, false, "needs_attention"],
  ["failed", true, false, "needs_attention"],
  ["failed", false, false, null],
  ["idle", true, true, "needs_attention"],
  ["idle", false, true, null],
  ["running", true, true, "working"],
  ["queued", false, false, "working"],
  ["completed", true, false, "unread"],
  ["cancelled", false, false, null],
] as const)("classifies %s (unread %s, failed %s) as %s", (status, unread, failed, state) => {
  expect(activityAttention(status, unread, failed)).toBe(state);
});

it("puts each conversation in one section", () => {
  const run = (botId: string, status: RunStatus, groupId: string | null = null) =>
    ({ botId, groupId, status }) as const;
  const ask = run("marketing", "waiting_input");
  const work = run("research", "running", "launch");
  const failedUnread = run("writer", "failed");
  const done = run("editor", "completed");
  const doneUnread = run("chief", "completed");
  const sections = activitySections({
    active: [ask, work],
    recent: [failedUnread, done, doneUnread],
    bots: [
      { id: "research", status: "running", unread: true },
      { id: "writer", status: "idle", unread: true, runErrorId: "run-1" },
      { id: "editor", status: "idle", unread: false },
      { id: "chief", status: "idle", unread: true },
    ],
    groups: [
      { id: "launch", unread: true },
      { id: "quiet", unread: true },
    ],
  });
  expect(sections.attention).toEqual([ask, failedUnread]);
  expect(sections.working).toEqual([work]);
  expect(sections.unreadBots.map((bot) => bot.id)).toEqual(["chief"]);
  expect(sections.unreadGroups.map((group) => group.id)).toEqual(["quiet"]);
  expect(sections.recent).toEqual([done]);
});
