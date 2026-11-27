import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botEyeInk, botEyeTone, chatUserBubbleColors, contrastRatio } from "./bot-avatar-colors.js";

describe("botEyeTone", () => {
  it("cuts eyes in the page color unless the body is nearly white or black", () => {
    expect(botEyeTone("#FF5EB1")).toBe("page");
    // White cut-outs would fade on a pale amber body in light mode.
    expect(botEyeTone("#FFAF38")).toBe("dark");
    expect(botEyeTone("#FFFFFF")).toBe("dark");
    expect(botEyeTone("#111111")).toBe("light");
  });
});

function oklchHueDegrees(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(bb, a) * 180) / Math.PI;
}

describe("chatUserBubbleColors", () => {
  it("wears the bot's color under readable text", () => {
    const red = chatUserBubbleColors("#EF4444::shape_2", "bot-1");
    expect(red?.foreground).toBe("#FFFFFF");
    expect(contrastRatio(red!.background, red!.foreground)).toBeGreaterThanOrEqual(4.5);
    // A bot saved with a color's earlier value wears that color's current bubble.
    expect(chatUserBubbleColors("#64748B", "bot-1")).toEqual(
      chatUserBubbleColors("#94A3B8", "bot-1"),
    );
  });

  it.each(BOT_COLOR_LIST.filter((color) => color.id !== "white"))(
    "keeps $name white text at 4.5:1 contrast",
    ({ hex }) => {
      const bubble = chatUserBubbleColors(hex, "bot-1");
      expect(bubble).toBeDefined();
      expect(bubble!.foreground).toBe("#FFFFFF");
      expect(contrastRatio(bubble!.background, bubble!.foreground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("leaves colors that already read well as the avatar's own", () => {
    expect(chatUserBubbleColors("#1E40AF", "bot-1")?.background).toBe("#1E40AF");
  });

  it.each(["#FFFF00", "#FFE066", "#FAFAFA", "#C9A8FF", "#F00", "#00FFFF"])(
    "gives custom %s body-text contrast",
    (color) => {
      const bubble = chatUserBubbleColors(color, "bot-1")!;
      expect(bubble.foreground).toBe("#FFFFFF");
      expect(contrastRatio(bubble.background, bubble.foreground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("deepens bright colors without turning them muddy", () => {
    const orange = chatUserBubbleColors("#FF781C", "bot-1")!;
    // Darkening in RGB pulled orange toward brown; OKLCH keeps it orange.
    expect(orange.background).toBe("#C35500");
    expect(contrastRatio(orange.background, orange.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["#FFFF00", "#00FFFF", "#00FF00", "#FFE066"])(
    "keeps the hue of bright custom %s when deepening it",
    (color) => {
      const bubble = chatUserBubbleColors(color, "bot-1")!;
      const drift = Math.abs(oklchHueDegrees(bubble.background) - oklchHueDegrees(color));
      expect(Math.min(drift, 360 - drift)).toBeLessThan(1);
      expect(contrastRatio(bubble.background, bubble.foreground)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("deepens custom violet for readable white text", () => {
    const bubble = chatUserBubbleColors("#C9A8FF", "bot-1")!;
    expect(bubble.foreground).toBe("#FFFFFF");
    expect(bubble.background).not.toBe("#C9A8FF");
    expect(contrastRatio(bubble.background, bubble.foreground)).toBeGreaterThanOrEqual(4.5);
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
