import { describe, expect, it } from "vitest";
import type { MessageMenuEntry, MessageMenuSymbol } from "./message-context-menu";
import { buildMessageContextMenu, messageMenuReaction } from "./message-context-menu";

const labels: Record<MessageMenuSymbol, string> = {
  reply: "Reply",
  copy: "Copy",
  react: "React",
  quote: "Quote",
  speak: "Speak message",
  select: "Select text",
};

const reactions = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;

function ids(entries: readonly MessageMenuEntry[]): string[] {
  return entries.flatMap((entry) => [entry.id, ...(entry.subactions ? ids(entry.subactions) : [])]);
}

describe("message context menu", () => {
  it("leads with reply, copy, and react, then groups the rest inline", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: true, react: true, speak: true, select: true },
    });
    expect(menu.map((entry) => entry.id)).toEqual(["reply", "copy", "react", "secondary"]);
    expect(menu.map((entry) => entry.symbol)).toEqual(["reply", "copy", "react", undefined]);
    const secondary = menu[3]!;
    expect(secondary).toMatchObject({ title: "", displayInline: true });
    expect(secondary.subactions?.map((entry) => entry.id)).toEqual(["quote", "speak", "select"]);
    expect(
      menu.find((entry) => entry.id === "react")?.subactions?.map((entry) => entry.title),
    ).toEqual([...reactions]);
    expect(ids(menu)).not.toContain("cancel");
  });

  it("keeps read-only history copyable without reply, quote, or reaction actions", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { reply: false, quote: false, react: false, speak: true, select: true },
    });
    expect(ids(menu)).toEqual(["copy", "secondary", "speak", "select"]);
  });

  it("omits actions the message cannot perform", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: false, react: false, speak: false, select: true },
    });
    expect(ids(menu)).toEqual(["reply", "copy", "secondary", "select"]);
  });

  it("drops the inline section when every secondary action is absent", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: false, react: true, speak: false, select: false },
    });
    expect(menu.map((entry) => entry.id)).toEqual(["reply", "copy", "react"]);
  });

  it("reads a reaction id back out of a menu event", () => {
    expect(messageMenuReaction("reaction:🎉")).toBe("🎉");
    expect(messageMenuReaction("reply")).toBeNull();
  });
});
