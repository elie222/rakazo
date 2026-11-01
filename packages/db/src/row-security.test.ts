import { describe, expect, it } from "vitest";
import { rlsBypassKey } from "./row-security.js";

describe("rlsBypassKey", () => {
  it("follows the password pg logs in with", () => {
    const key = rlsBypassKey("postgres://app:secret@db/rakazo");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rlsBypassKey("postgres://app@db/rakazo?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:other@db/rakazo?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:secret@db/rakazo?password=")).toBe(key);
    expect(rlsBypassKey("postgres://app:s%cret@db/rakazo")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is empty without a password", () => {
    expect(rlsBypassKey("postgres://app@db/rakazo")).toBe("");
    expect(rlsBypassKey("not a url")).toBe("");
  });
});
