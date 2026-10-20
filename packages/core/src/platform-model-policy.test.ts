import { describe, expect, it } from "vitest";
import { parsePlatformModelAllowlist, platformModelAllowed } from "./signup-policy.js";

describe("platform model allowlist", () => {
  it.each([
    [undefined, "user@example.test", false, true],
    ["", "user@example.test", false, true],
    ["  ", "user@example.test", false, true],
    ["other@example.test", "user@example.test", true, true],
    ["USER@example.test", "user@EXAMPLE.test", false, true],
    ["@EXAMPLE.test", "USER@example.test", false, true],
    ["@example.test", "user@sub.example.test", false, false],
    ["other@example.test", "user@example.test", false, false],
    ["none@x, @example.test", "none@x", false, true],
    ["none, @example.test", "user@example.test", false, true],
    ...["none", "NONE", " none "].flatMap<[string, string, boolean, boolean]>((raw) => [
      [raw, "owner@example.test", true, true],
      [raw, "user@example.test", false, false],
      [raw, "none@x", false, false],
      [raw, "none", false, false],
    ]),
  ])("checks %s for %s (owner %s)", (raw, email, isOwner, allowed) => {
    expect(
      platformModelAllowed({ allowlist: parsePlatformModelAllowlist(raw), email, isOwner }),
    ).toBe(allowed);
  });
});
