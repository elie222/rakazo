import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ values: new Map<string, string>(), fail: false }));
const secureStorage = {
  getItem: (key: string) => {
    if (store.fail) throw new Error("locked");
    return store.values.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (store.fail) throw new Error("locked");
    store.values.set(key, value);
  },
};

import { clearStartupError, readStartupError, saveStartupError } from "./startup-error";

beforeEach(() => {
  store.values.clear();
  store.fail = false;
});

describe("persisted startup error", () => {
  it("scrubs private values before writing, bounds storage, and preserves the error type", () => {
    const error = new TypeError("Bearer private-token");
    error.stack = `at /Users/example/project/startup.ts:42\n${"x".repeat(10_000)}`;
    saveStartupError(error, secureStorage);
    expect(store.values.get("rakazo.startup-error")).not.toMatch(/private-token|\/Users\/example/);
    expect(store.values.get("rakazo.startup-error")!.length).toBeLessThan(8_192);
    expect(readStartupError(secureStorage)).toMatchObject({
      name: "TypeError",
      stack: expect.stringContaining("startup.ts:42"),
    });
    clearStartupError(secureStorage);
    expect(readStartupError(secureStorage)).toBeUndefined();
  });

  it("round-trips escaped error text within the serialized size limit", () => {
    const error = new Error('"\\\n\u0000'.repeat(1_024));
    error.stack = `at startup.ts:42\n${'"\\\n\u0000'.repeat(4_096)}`;
    saveStartupError(error, secureStorage);
    expect(store.values.get("rakazo.startup-error")!.length).toBeLessThanOrEqual(8_192);
    expect(readStartupError(secureStorage)?.message).toBe(error.message.slice(0, 1_024));
  });

  it("does not replay another server's error even if wiping storage failed", () => {
    store.values.set("rakazo.api_base", "https://first.example.com");
    saveStartupError(new Error("old server"), secureStorage);
    store.fail = true;
    clearStartupError(secureStorage);
    store.fail = false;
    store.values.set("rakazo.api_base", "https://second.example.com");
    expect(readStartupError(secureStorage)).toBeUndefined();
  });

  it("ignores malformed records and unavailable secure storage", () => {
    for (const raw of ["{", "[]", "null", '{"message":42}', "x".repeat(8_193)]) {
      store.values.set("rakazo.startup-error", raw);
      expect(readStartupError(secureStorage)).toBeUndefined();
    }
    store.fail = true;
    expect(() => saveStartupError(new Error("original"), secureStorage)).not.toThrow();
    expect(() => clearStartupError(secureStorage)).not.toThrow();
    expect(readStartupError(secureStorage)).toBeUndefined();
  });
});
