import { describe, expect, it } from "vitest";
import { safeInternalAppPath } from "./safe-navigation.js";

const origin = "https://rakazo.example";

describe("safeInternalAppPath", () => {
  it("accepts internal paths with query and hash", () => {
    expect(safeInternalAppPath("/app", origin)).toBe("/app");
    expect(safeInternalAppPath("/share/abc", origin)).toBe("/share/abc");
    expect(safeInternalAppPath("/app?x=1", origin)).toBe("/app?x=1");
    expect(safeInternalAppPath("/app#tab", origin)).toBe("/app#tab");
  });

  it("rejects cross-origin and protocol-relative paths", () => {
    expect(safeInternalAppPath("//attacker.example", origin)).toBeNull();
    expect(safeInternalAppPath("/\\attacker.example", origin)).toBeNull();
    expect(safeInternalAppPath("https://attacker.example/phish", origin)).toBeNull();
  });
});
