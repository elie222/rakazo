import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { canSelectMessage, selectedMessages, toggleSelected } from "./message-selection";

const text = (id: string, body = id) => ({
  id,
  blocks: [{ kind: "text", text: body }] as MessageBlock[],
});

describe("canSelectMessage", () => {
  it("accepts a message with text", () => {
    expect(canSelectMessage(text("m1"))).toBe(true);
  });

  it("rejects a message with nothing to copy", () => {
    expect(canSelectMessage(text("m1", "  "))).toBe(false);
    expect(canSelectMessage({ id: "m2", blocks: [{ kind: "card", lines: [] }] })).toBe(false);
  });

  it("rejects live progress and subagent rows, whose ids change when they settle", () => {
    expect(canSelectMessage(text("progress:run-1", "working"))).toBe(false);
    expect(canSelectMessage(text("subagent:agent-1", "researching"))).toBe(false);
    expect(canSelectMessage(text("m1", "progress:"))).toBe(true);
  });
});

describe("toggleSelected", () => {
  it("adds and removes without changing the set it was given", () => {
    const empty: ReadonlySet<string> = new Set();
    const one = toggleSelected(empty, "a");
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect(toggleSelected(one, "a").size).toBe(0);
  });
});

describe("selectedMessages", () => {
  const messages = [
    text("a"),
    text("b"),
    text("c"),
    text("progress:x"),
    text("subagent:y"),
    text("d", " "),
  ];

  it("returns the chosen messages in chat order, whatever order they were chosen in", () => {
    expect(selectedMessages(messages, new Set(["c", "a"])).map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("is empty when not selecting", () => {
    expect(selectedMessages(messages, null)).toEqual([]);
  });

  it("drops a chosen message that left the chat or can no longer be copied", () => {
    const ids = new Set(["a", "gone", "progress:x", "subagent:y", "d"]);
    expect(selectedMessages(messages, ids).map((m) => m.id)).toEqual(["a"]);
  });
});
