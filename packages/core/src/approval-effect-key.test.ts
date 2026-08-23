import { describe, expect, it } from "vitest";
import { approvalEffectKey, stableJsonValue } from "./approval-effect-key.js";

describe("stableJsonValue", () => {
  it("sorts object keys", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("rejects values that cannot be represented uniquely as JSON", () => {
    const sparse = Array(1);

    for (const value of [undefined, [undefined], sparse, { value: undefined }, Number.NaN]) {
      expect(() => stableJsonValue(value)).toThrow("only JSON values");
    }
    expect(stableJsonValue([])).toBe("[]");
    expect(stableJsonValue([null])).toBe("[null]");
  });

  it("rejects cyclic and non-plain objects", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => stableJsonValue(cyclic)).toThrow("only JSON values");
    expect(() => stableJsonValue(new Date(0))).toThrow("only JSON values");
  });
});

describe("approvalEffectKey", () => {
  it("includes run and tool with an opaque digest of canonical args", () => {
    const key = approvalEffectKey("run-1", "destination.write", { body: "private draft" });

    expect(key).toMatch(/^run-1:destination\.write:[a-f0-9]{64}$/);
    expect(key).not.toContain("private draft");
  });
});
