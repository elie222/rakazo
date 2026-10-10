import { reduceLiveMessageBlocks, withLiveStreamingProgress } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { MobileSnapshot } from "./api";
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
          state: "ready",
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
    expect(reconcileVisibleThreadSnapshot(messages, reordered)).toBe(reordered);
    const edited = structuredClone(messages);
    edited.messages[0]!.blocks = [{ kind: "text", text: "Edited" }];
    expect(reconcileVisibleThreadSnapshot(messages, edited)).toBe(edited);
    expect(reconcileVisibleThreadSnapshot(null, previous)).toBe(previous);
    expect(reconcileVisibleThreadSnapshot(previous, null)).toBeNull();
  });
});
