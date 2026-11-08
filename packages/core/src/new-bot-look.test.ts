import { describe, expect, it } from "vitest";
import { ORGANIC_AVATAR_HEART_FAMILY, organicAvatarFamily } from "./avatar-shape.js";
import { newBotLook, newBotLookInput, newBotPreviewIdentity } from "./new-bot-look.js";

describe("newBotLook", () => {
  it("reserves a valid id that never draws the heart body", () => {
    for (let index = 0; index < 50; index++) {
      const look = newBotLook();
      expect(look.id).toMatch(/^c[a-z0-9]{24}$/);
      expect(organicAvatarFamily(look.id)).not.toBe(ORGANIC_AVATAR_HEART_FAMILY);
    }
  });

  it("keeps the preview's look through creation", () => {
    const look = { id: "c".padEnd(25, "a"), color: "#2A92FE", identity: "look-3-0" };
    expect(newBotPreviewIdentity("rakazo", look)).toBe(look.id);
    expect(newBotLookInput("rakazo", look)).toEqual({ color: look.color, id: look.id });
    expect(newBotPreviewIdentity("organic", look)).toBe(look.identity);
    expect(newBotLookInput("organic", look)).toEqual({
      color: look.color,
      avatarFamily: organicAvatarFamily(look.identity),
    });
    const shaped = { ...look, color: "#2A92FE::shape_2" };
    expect(newBotLookInput("organic", shaped)).toEqual({ color: shaped.color });
  });
});
