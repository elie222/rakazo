import { shippedBotAvatarShapePath } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { botEyeInk, mobileBotAvatarPresentation } from "./bot-avatar.js";

describe("mobile bot avatar presentation", () => {
  it("keeps the stored shape path instead of dropping it to a color fill", () => {
    const presented = mobileBotAvatarPresentation("#8B5CF6::shape_3");
    expect(presented).toEqual({
      kind: "shape",
      color: "#A97EFE",
      shapeIndex: 3,
      shapePath: shippedBotAvatarShapePath(3),
    });
    expect(presented.kind === "shape" && presented.shapePath).not.toBe(
      shippedBotAvatarShapePath(0),
    );
  });

  it("cuts the eyes in the page color unless the body is nearly white", () => {
    const dark = { background: "#121212", foreground: "#F5F5F5" };
    const light = { background: "#FFFFFF", foreground: "#1C1C1C" };
    expect(botEyeInk("#FF5EB1", dark)).toBe("#121212");
    expect(botEyeInk("#FF5EB1", light)).toBe("#FFFFFF");
    expect(botEyeInk("#FFFFFF", light)).toBe("#1C1C1C");
  });

  it("draws a color saved as its earlier value as the current one", () => {
    expect(mobileBotAvatarPresentation("#8B5CF6")).toEqual({ kind: "color", color: "#A97EFE" });
    expect(mobileBotAvatarPresentation("#123456")).toEqual({ kind: "color", color: "#123456" });
  });

  it("still treats data images and remote URLs as before", () => {
    expect(mobileBotAvatarPresentation("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
    expect(mobileBotAvatarPresentation("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
  });
});
