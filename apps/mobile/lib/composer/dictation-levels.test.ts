import { expect, it } from "vitest";
import {
  DICTATION_LEVEL_COUNT,
  levelFromDecibels,
  QUIET_LEVELS,
  withLevel,
} from "./dictation-levels";

it("draws silence flat, full scale full, and speech in between", () => {
  expect(levelFromDecibels(undefined)).toBe(0);
  expect(levelFromDecibels(-80)).toBe(0);
  expect(levelFromDecibels(0)).toBe(1);
  const speech = levelFromDecibels(-30);
  expect(speech).toBeGreaterThan(0.1);
  expect(speech).toBeLessThan(levelFromDecibels(-10));
});

it("adds each read at the end and keeps the length", () => {
  const next = withLevel(QUIET_LEVELS, 0);
  expect(next).toHaveLength(DICTATION_LEVEL_COUNT);
  expect(next.at(-1)).toBe(1);
  expect(next.at(-2)).toBe(0);
});
