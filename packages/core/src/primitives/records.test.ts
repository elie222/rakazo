import { describe, expect, it } from "vitest";
import { isPlainObject, isRecord } from "./records.js";

class Point {
  x = 1;
}

describe("isRecord", () => {
  it("accepts objects and rejects null, arrays and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Point())).toBe(true);
    expect(isRecord(new Date())).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(0)).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("accepts only object literals and null-prototype objects", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Point())).toBe(false);
    expect(isPlainObject(new Uint8Array(1))).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("text")).toBe(false);
  });
});
