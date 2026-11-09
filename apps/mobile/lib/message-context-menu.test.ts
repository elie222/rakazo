import { describe, expect, it, vi } from "vitest";
import type { MessageMenuEntry, MessageMenuSymbol } from "./message-context-menu";
import { buildMessageContextMenu, messageMenuReaction } from "./message-context-menu";

vi.mock("react-native", () => ({ Share: { share: vi.fn() } }));

const labels: Record<MessageMenuSymbol, string> = {
  reply: "Reply",
  copy: "Copy",
  share: "Share",
  favorite: "Favorite",
  react: "React",
  quote: "Quote",
  speak: "Speak message",
  select: "Select text",
  unread: "Mark as unread",
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
    expect(menu.map((entry) => entry.id)).toEqual(["reply", "copy", "share", "react", "secondary"]);
    expect(menu.map((entry) => entry.symbol)).toEqual([
      "reply",
      "copy",
      "share",
      "react",
      undefined,
    ]);
    const secondary = menu[4]!;
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
    expect(ids(menu)).toEqual(["copy", "share", "secondary", "speak", "select"]);
  });

  it("omits actions the message cannot perform", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: false, react: false, speak: false, select: true },
    });
    expect(ids(menu)).toEqual(["reply", "copy", "share", "secondary", "select"]);
  });

  it("drops the inline section when every secondary action is absent", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: false, react: true, speak: false, select: false },
    });
    expect(menu.map((entry) => entry.id)).toEqual(["reply", "copy", "share", "react"]);
  });

  it("offers Mark as unread right after Reply, only when asked", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: true, react: false, speak: true, select: true, unread: true },
    });
    expect(menu.map((entry) => [entry.id, entry.title, entry.symbol])).toEqual([
      ["reply", "Reply", "reply"],
      ["unread", "Mark as unread", "unread"],
      ["copy", "Copy", "copy"],
      ["share", "Share", "share"],
      ["secondary", "", undefined],
    ]);
    expect(ids(menu.find((entry) => entry.id === "secondary")?.subactions ?? [])).toEqual([
      "quote",
      "speak",
      "select",
    ]);
    expect(
      ids(
        buildMessageContextMenu({
          labels,
          reactions,
          include: { quote: false, react: false, speak: false, select: false },
        }),
      ),
    ).not.toContain("unread");
  });

  it("offers Favorite right after Share for a bot reply, only when asked", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: true, react: true, speak: true, select: true, favorite: true },
    });
    expect(menu.map((entry) => entry.id)).toEqual([
      "reply",
      "copy",
      "share",
      "favorite",
      "react",
      "secondary",
    ]);
    expect(
      ids(
        buildMessageContextMenu({
          labels,
          reactions,
          include: { quote: true, react: true, speak: true, select: true },
        }),
      ),
    ).not.toContain("favorite");
  });

  it("reads a reaction id back out of a menu event", () => {
    expect(messageMenuReaction("reaction:🎉")).toBe("🎉");
    expect(messageMenuReaction("reply")).toBeNull();
  });

  it("drops share for a message with no text to share", () => {
    const menu = buildMessageContextMenu({
      labels,
      reactions,
      include: { quote: true, react: true, speak: true, select: true, share: false },
    });
    expect(ids(menu)).not.toContain("share");
  });
});
