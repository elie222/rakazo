import { describe, expect, it } from "vitest";

import {
  avatarColor,
  avatarShape,
  isAvatarPhoto,
  withAvatarColor,
  withAvatarShape,
} from "./bot-avatar-edit";

describe("bot avatar editing", () => {
  it("keeps the shape when the color changes", () => {
    expect(withAvatarColor("#3EC5A8::shape_3", "#F5A03C")).toBe("#F5A03C::shape_3");
    expect(withAvatarColor("#3EC5A8", "#F5A03C")).toBe("#F5A03C");
  });

  it("keeps the color when the shape changes", () => {
    expect(withAvatarShape("#F5A03C", 5)).toBe("#F5A03C::shape_5");
    expect(avatarShape("#F5A03C::shape_5")).toBe(5);
    expect(avatarColor("#F5A03C::shape_5")).toBe("#F5A03C");
  });

  it("replaces a photo with a plain color", () => {
    const photo = "data:image/webp;base64,AAAA";
    expect(isAvatarPhoto(photo)).toBe(true);
    expect(isAvatarPhoto(avatarColor(photo))).toBe(false);
    expect(withAvatarColor(photo, "#6A6BF5")).toBe("#6A6BF5");
    expect(avatarShape(photo)).toBeNull();
  });
});
