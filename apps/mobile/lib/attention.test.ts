import type { AttentionItem } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));

import { attentionDetail, attentionHref, attentionSections, attentionTitle } from "./attention";

const translate = (message: string, values?: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));

const item = (overrides: Partial<AttentionItem>): AttentionItem =>
  ({
    id: "run:run-1",
    kind: "question",
    botId: "bot-1",
    botName: "Scout",
    groupId: null,
    groupName: null,
    threadId: "thread-1",
    runId: "run-1",
    routineId: null,
    messageId: "message-1",
    detail: "Which city should I use?",
    createdAt: "2026-01-01T00:00:00.000Z",
    actions: [],
    ...overrides,
  }) as AttentionItem;

it("groups waiting items, failures and delayed routines in server order", () => {
  const sections = attentionSections(
    [
      item({ id: "q", kind: "question" }),
      item({ id: "a", kind: "approval", detail: "Allow the fetch?" }),
      item({ id: "s", kind: "secret", detail: "API key" }),
      item({ id: "t", kind: "takeover", detail: "" }),
      item({ id: "f", kind: "failed", detail: "fail this run" }),
      item({ id: "r", kind: "routine_delayed", detail: "Morning brief" }),
    ],
    translate,
  );
  expect(sections.map((section) => [section.key, section.items.length])).toEqual([
    ["waiting", 4],
    ["failed", 1],
    ["routines", 1],
  ]);
});

it("names the item and its group", () => {
  expect(attentionTitle(item({ kind: "question" }), translate)).toBe("Scout needs an answer");
  expect(attentionTitle(item({ kind: "approval", groupName: "Launch team" }), translate)).toBe(
    "Launch team needs approval",
  );
});

it("falls back to calm detail copy only when the server has none", () => {
  expect(attentionDetail(item({ kind: "takeover", detail: "" }), translate)).toBe(
    "Open its computer to continue.",
  );
  expect(attentionDetail(item({ kind: "failed", detail: "fail this run" }), translate)).toBe(
    "fail this run",
  );
});

it("opens the group chat or the bot chat", () => {
  expect(attentionHref(item({ kind: "question" }))).toEqual({
    pathname: "/thread",
    params: { botId: "bot-1", name: "Scout" },
  });
  expect(
    attentionHref(item({ kind: "approval", groupId: "group-1", groupName: "Launch team" })),
  ).toEqual({
    pathname: "/group-thread",
    params: { groupId: "group-1", name: "Launch team" },
  });
});
