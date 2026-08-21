import { describe, expect, it } from "vitest";
import { approvalEffectKey, stableJsonValue } from "./approval-effect-key.js";

describe("stableJsonValue", () => {
  it("sorts object keys", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("approvalEffectKey", () => {
  it("includes run and tool with an opaque digest of canonical args", () => {
    const key = approvalEffectKey("run-1", "destination.write", { body: "private draft" });

    expect(key).toMatch(/^run-1:destination\.write:[a-f0-9]{64}$/);
    expect(key).not.toContain("private draft");
  });
});
