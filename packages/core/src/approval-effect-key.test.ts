import { describe, expect, it } from "vitest";
import {
  approvalEffectKey,
  stableJsonValue,
  toolEffectIdempotencyKey,
} from "./approval-effect-key.js";

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

describe("toolEffectIdempotencyKey", () => {
  it("scopes provider tool-call ids to run, tool, and args", () => {
    const write = { path: "a.txt", content: "one" };
    expect(toolEffectIdempotencyKey("run-1", "write_file", "call_0", write)).toMatch(
      /^run-1:write_file:call_0:[a-f0-9]{64}$/,
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", "call_0", write)).not.toBe(
      toolEffectIdempotencyKey("run-2", "write_file", "call_0", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", "call_0", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "shell", "call_0", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", "call_0", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "write_file", "call_0", {
        path: "a.txt",
        content: "two",
      }),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", "call_0", write)).not.toBe("call_0");
  });

  it("is stable for a true retry of the same effect", () => {
    const args = { path: "MEMORY.md", content: "fact" };
    expect(toolEffectIdempotencyKey("run-1", "remember", "call_0", args)).toBe(
      toolEffectIdempotencyKey("run-1", "remember", "call_0", args),
    );
  });
});
