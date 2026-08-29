import { describe, expect, it } from "vitest";
import { avatarIdentitySeed, organicAvatarPath } from "./avatar-shape.js";

describe("organic avatar geometry", () => {
  it("is stable for an identity and changes across identities", () => {
    const first = organicAvatarPath(avatarIdentitySeed("research"));
    expect(first).toBe(organicAvatarPath(avatarIdentitySeed("research")));
    expect(first).not.toBe(organicAvatarPath(avatarIdentitySeed("health")));
  });

  it("emits only path geometry from a numeric seed", () => {
    const path = organicAvatarPath(42);
    expect(path).toMatch(/^M[-0-9. ]+(?:C[-0-9. ]+)+Z$/);
    expect(path).not.toMatch(/<|>|javascript:|url\(/i);
  });

  it("produces ten distinct smooth shape families", () => {
    const families = Array.from({ length: 10 }, (_, seed) =>
      organicAvatarPath(seed, -((seed % 360) * Math.PI) / 180),
    );
    expect(new Set(families)).toHaveLength(10);
    expect(families.every((path) => (path.match(/C/g) ?? []).length >= 12)).toBe(true);
  });
});
