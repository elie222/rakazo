import { reduceLiveMessageBlocks, withLiveStreamingProgress } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { MobileSnapshot } from "../api/mobile-types";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";

function snapshot(): MobileSnapshot {
  return {
    threadId: "thread-1",
    cursor: 0,
    messages: [],
    olderCursor: null,
    run: { id: "run-1", status: "running" },
  };
}

describe("visible thread snapshot publication", () => {
  it("models 200 progress events with five visible changes as 200 commits before and five after", () => {
    let raw = snapshot();
    let before = raw;
    let after = raw;
    let beforeCommits = 0;
    let afterCommits = 0;
    for (let event = 1; event <= 200; event += 1) {
      raw = {
        ...raw,
        cursor: event,
        messages: [
          {
            id: "progress:run-1",
            role: "bot",
            blocks: reduceLiveMessageBlocks(raw.messages[0]?.blocks ?? [], {
              type: "progress",
              payload: { text: `Stage ${Math.ceil(event / 40)}`, activity: true },
            }),
          },
        ],
      };
      const visible = withLiveStreamingProgress(raw, false)!;
      if (before !== visible) beforeCommits += 1;
      before = visible;
      const reconciled = reconcileVisibleThreadSnapshot(after, visible)!;
      if (after !== reconciled) afterCommits += 1;
      after = reconciled;
      expect(after.messages).toEqual(before.messages);
      expect(after.run).toEqual(before.run);
    }
    expect({ beforeCommits, afterCommits }).toEqual({ beforeCommits: 200, afterCommits: 5 });
    expect(raw.cursor).toBe(200);
  });

  it("ignores hidden text but publishes each changed text value when streaming is enabled", () => {
    const initial = snapshot();
    let streaming: MobileSnapshot = initial;
    for (let event = 1; event <= 200; event += 1) {
      const raw: MobileSnapshot = {
        ...initial,
        cursor: event,
        messages: [
          { id: "progress:run-1", role: "bot", blocks: [{ kind: "progress", text: `${event}` }] },
        ],
      };
      expect(reconcileVisibleThreadSnapshot(initial, withLiveStreamingProgress(raw, false))).toBe(
        initial,
      );
      expect(reconcileVisibleThreadSnapshot(streaming, withLiveStreamingProgress(raw, true))).toBe(
        raw,
      );
      streaming = raw;
    }
    expect(
      reconcileVisibleThreadSnapshot(streaming, withLiveStreamingProgress(streaming, false)),
    ).toEqual({ ...streaming, messages: [] });
  });

  it("publishes all snapshot fields except cursor, including nested values and array order", () => {
    const previous = snapshot();
    expect(reconcileVisibleThreadSnapshot(previous, structuredClone(previous))).toBe(previous);
    const changes: Partial<MobileSnapshot>[] = [
      { threadId: "thread-2" },
      { botId: "bot-1" },
      { groupId: "group-1", groupName: "Group" },
      { olderCursor: 1 },
      { run: { id: "run-1", status: "waiting_input" } },
      { run: { id: "run-1", status: "failed", error: "Failed" } },
      { run: null },
      { activeRuns: [{ id: "run-2", status: "running" }] },
      { members: [] },
      {
        computer: {
          state: "running",
          controlHolder: "bot",
          screenAvailable: true,
          mode: "team",
          busyBotName: null,
        },
      },
      { messages: [{ id: "message-1", role: "bot", blocks: [{ kind: "text", text: "Done" }] }] },
    ];
    for (const change of changes) {
      const next = { ...previous, ...change };
      expect(reconcileVisibleThreadSnapshot(previous, next)).toBe(next);
    }
    const messages: MobileSnapshot = {
      ...previous,
      messages: [
        { id: "message-1", role: "bot", blocks: [{ kind: "text", text: "One" }] },
        { id: "message-2", role: "bot", blocks: [{ kind: "text", text: "Two" }] },
      ],
    };
    const reordered = { ...messages, messages: [...messages.messages].reverse() };
    expect(reconcileVisibleThreadSnapshot(messages, reordered)).toEqual(reordered);
    const edited = structuredClone(messages);
    edited.messages[0]!.blocks = [{ kind: "text", text: "Edited" }];
    expect(reconcileVisibleThreadSnapshot(messages, edited)).toEqual(edited);
    expect(reconcileVisibleThreadSnapshot(null, previous)).toBe(previous);
    expect(reconcileVisibleThreadSnapshot(previous, null)).toBeNull();
  });

  it("keeps unchanged messages when the snapshot around them changes", () => {
    const shown: MobileSnapshot = {
      ...snapshot(),
      messages: [
        { id: "message-1", role: "user", blocks: [{ kind: "text", text: "Hi" }] },
        { id: "message-2", role: "bot", blocks: [{ kind: "text", text: "Working" }] },
      ],
    };
    const refreshed = structuredClone(shown);
    refreshed.run = null;
    refreshed.messages[1]!.blocks = [{ kind: "text", text: "Done" }];

    const next = reconcileVisibleThreadSnapshot(shown, refreshed);

    expect(next).toEqual(refreshed);
    expect(next?.messages[0]).toBe(shown.messages[0]);
    expect(next?.messages[1]).toBe(refreshed.messages[1]);
  });

  it("keeps the message list itself when only the run changed", () => {
    const shown: MobileSnapshot = {
      ...snapshot(),
      messages: [{ id: "message-1", role: "user", blocks: [{ kind: "text", text: "Hi" }] }],
    };

    const next = reconcileVisibleThreadSnapshot(shown, { ...structuredClone(shown), run: null });

    expect(next?.run).toBeNull();
    expect(next?.messages).toBe(shown.messages);
  });

  it("keeps a group's members when only a message changed, so other rows are not drawn again", () => {
    const shown: MobileSnapshot = {
      ...snapshot(),
      members: [{ botId: "bot-1", name: "Ada" }] as MobileSnapshot["members"],
      messages: [{ id: "message-1", role: "bot", blocks: [{ kind: "text", text: "Working" }] }],
    };
    const refreshed = structuredClone(shown);
    refreshed.messages[0]!.blocks = [{ kind: "text", text: "Done" }];

    const next = reconcileVisibleThreadSnapshot(shown, refreshed);

    expect(next).toEqual(refreshed);
    expect(next?.members).toBe(shown.members);
    expect(next?.run).toBe(shown.run);
    expect(next?.messages[0]).toBe(refreshed.messages[0]);
  });
});
