import { describe, expect, it } from "vitest";
import {
  BOT_COLOR_LIST,
  chatUserBubbleColors,
  contrastRatio,
  resolvePersonaColorDef,
} from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("keeps Amber Gold on dark eyes instead of a brightness heuristic", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#141414");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#FFFFFF");
  });
});

describe("chatUserBubbleColors", () => {
  it("wears the bot's color under readable text", () => {
    const red = chatUserBubbleColors("#EF4444::shape_2", "bot-1");
    expect(red?.foreground).toBe("#FFFFFF");
    expect(contrastRatio(red!.background, red!.foreground)).toBeGreaterThanOrEqual(4.5);
    expect(chatUserBubbleColors("#64748B", "bot-1")).toEqual({
      background: "#64748B",
      foreground: "#FFFFFF",
    });
  });

  it.each(BOT_COLOR_LIST.filter((color) => color.id !== "white"))(
    "keeps $name body text at AA contrast",
    ({ hex }) => {
      const bubble = chatUserBubbleColors(hex, "bot-1");
      expect(bubble).toBeDefined();
      expect(bubble!.foreground).toBe("#FFFFFF");
      expect(contrastRatio(bubble!.background, bubble!.foreground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("deepens custom violet for readable white text", () => {
    const bubble = chatUserBubbleColors("#A855F7", "bot-1")!;
    expect(bubble.foreground).toBe("#FFFFFF");
    expect(bubble.background).not.toBe("#A855F7");
    expect(contrastRatio(bubble.background, bubble.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the neutral bubble for a photo or the white bot", () => {
    expect(chatUserBubbleColors("data:image/png;base64,AAAA", "bot-1")).toBeUndefined();
    expect(chatUserBubbleColors("#FFFFFF", "bot-1")).toBeUndefined();
  });
});
