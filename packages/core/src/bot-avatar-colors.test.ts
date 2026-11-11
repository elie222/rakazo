import { describe, expect, it } from "vitest";
import { botEyeInk, botEyeTone, chatUserBubbleColors } from "./bot-avatar-colors.js";

describe("botEyeTone", () => {
  it("cuts eyes in the page color unless the body is nearly white or black", () => {
    expect(botEyeTone("#FF5EB1")).toBe("page");
    // White cut-outs would fade on a pale amber body in light mode.
    expect(botEyeTone("#FFAF38")).toBe("dark");
    expect(botEyeTone("#FFFFFF")).toBe("dark");
    expect(botEyeTone("#111111")).toBe("light");
  });
});

describe("chatUserBubbleColors", () => {
  it("wears the bot's exact avatar color under white text", () => {
    expect(chatUserBubbleColors("#FF781C", "bot-1")).toEqual({
      background: "#FF781C",
      foreground: "#FFFFFF",
    });
    expect(chatUserBubbleColors("#EF4444::shape_2", "bot-1")?.background).toBe("#FF3E51");
    // A bot saved with a color's earlier value wears that color's current bubble.
    expect(chatUserBubbleColors("#64748B", "bot-1")).toEqual(
      chatUserBubbleColors("#94A3B8", "bot-1"),
    );
  });

  it("keeps the neutral bubble for a photo or the white bot", () => {
    expect(chatUserBubbleColors("data:image/png;base64,AAAA", "bot-1")).toBeUndefined();
    expect(chatUserBubbleColors("#FFFFFF", "bot-1")).toBeUndefined();
  });
});

it("cuts bot eyes in the page color unless the body is nearly white", () => {
  const dark = { background: "#121212", foreground: "#F5F5F5" };
  const light = { background: "#FFFFFF", foreground: "#1C1C1C" };
  expect(botEyeInk("#FF5EB1", dark)).toBe("#121212");
  expect(botEyeInk("#FF5EB1", light)).toBe("#FFFFFF");
  expect(botEyeInk("#FFFFFF", light)).toBe("#1C1C1C");
});
