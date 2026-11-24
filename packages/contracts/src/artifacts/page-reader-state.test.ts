import { describe, expect, it } from "vitest";
import { PAGE_STATE_MAX_KEYS, PageStateSchema } from "./page-reader-state.js";

const valid = (values: unknown) => PageStateSchema.safeParse(values).success;

describe("PageStateSchema", () => {
  it("takes plain JSON under keys a page can name", () => {
    expect(valid({ "packed.passport": true, note: "Charger", answers: [1, "b", null] })).toBe(true);
    expect(valid({ "has space": true })).toBe(false);
    expect(valid({ ["k".repeat(65)]: true })).toBe(false);
  });

  it("refuses values JSON cannot carry and nesting past six levels", () => {
    expect(valid({ n: Number.NaN })).toBe(false);
    expect(valid({ when: new Date() })).toBe(false);
    expect(valid({ deep: [[[[[[1]]]]]] })).toBe(true);
    expect(valid({ deep: [[[[[[[1]]]]]]] })).toBe(false);
  });

  it("caps the number of keys and the total size", () => {
    const keys = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, true]));
    expect(valid(keys(PAGE_STATE_MAX_KEYS))).toBe(true);
    expect(valid(keys(PAGE_STATE_MAX_KEYS + 1))).toBe(false);
    expect(valid({ note: "x".repeat(64 * 1024) })).toBe(false);
  });
});
