import { describe, expect, it } from "vitest";
import {
  avatarCheer,
  avatarIdentitySeed,
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_HEART_FAMILY,
  ORGANIC_AVATAR_LOOKS,
  organicAvatarEyes,
  organicAvatarFamily,
  organicAvatarPath,
  organicAvatarSampleIdentity,
} from "./avatar-shape.js";

describe("organic avatar geometry", () => {
  it("is stable for an identity and changes across identities", () => {
    const first = organicAvatarPath(avatarIdentitySeed("research"));
    expect(first).toBe(organicAvatarPath(avatarIdentitySeed("research")));
    expect(first).not.toBe(organicAvatarPath(avatarIdentitySeed("health")));
  });

  it("emits only path geometry from a numeric seed", () => {
    for (let seed = 0; seed < ORGANIC_AVATAR_FAMILY_COUNT; seed++) {
      expect(organicAvatarPath(seed)).toMatch(/^M[-0-9. MLHVAQZa-z]+Z$/);
      expect(organicAvatarPath(seed)).not.toMatch(/<|>|javascript:|url\(/i);
    }
  });

  it("draws one distinct body per family", () => {
    const bodies = Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, seed) =>
      organicAvatarPath(seed),
    );
    expect(new Set(bodies)).toHaveLength(ORGANIC_AVATAR_FAMILY_COUNT);
  });

  it("names the family an identity is drawn with", () => {
    for (const identity of ["research", "health", "cmh2x9k0a0000abcd1234efgh", "Chief"]) {
      const family = organicAvatarFamily(identity);
      expect(family).toBeGreaterThanOrEqual(0);
      expect(family).toBeLessThan(ORGANIC_AVATAR_FAMILY_COUNT);
      expect(organicAvatarPath(avatarIdentitySeed(identity))).toBe(organicAvatarPath(family));
    }
  });

  it("keeps the face inside the body and lowers it on bottom-heavy bodies", () => {
    for (let seed = 0; seed < ORGANIC_AVATAR_FAMILY_COUNT; seed++) {
      const eyes = organicAvatarEyes(seed);
      const { cheeks, smile } = avatarCheer(eyes);
      expect(eyes.cy - eyes.height / 2).toBeGreaterThan(30);
      expect(eyes.cy + eyes.height / 2).toBeLessThan(80);
      expect(cheeks.map((cheek) => cheek.cx)).toEqual([27, 73]);
      expect(cheeks[0]!.cy - eyes.cy).toBe(15);
      expect(smile).toBe(`M43 ${eyes.cy + 17}Q50 ${eyes.cy + 24} 57 ${eyes.cy + 17}`);
    }
  });
});

describe("organic avatar looks", () => {
  it("offers every look but the heart once", () => {
    expect([...ORGANIC_AVATAR_LOOKS].sort()).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(ORGANIC_AVATAR_LOOKS).not.toContain(ORGANIC_AVATAR_HEART_FAMILY);
  });

  it("finds a stable sample identity for each family", () => {
    for (let family = 0; family < ORGANIC_AVATAR_FAMILY_COUNT; family++) {
      const identity = organicAvatarSampleIdentity(family);
      expect(organicAvatarFamily(identity)).toBe(family);
      expect(organicAvatarSampleIdentity(family)).toBe(identity);
    }
  });
});
