import { expect, it } from "vitest";
import { transcriptTime } from "./meeting";

it.each([
  [0, "0:00"],
  [-5_000, "0:00"],
  [65_999, "1:05"],
  [3_599_000, "59:59"],
  [3_600_000, "1:00:00"],
  [3_723_000, "1:02:03"],
  [36_005_000, "10:00:05"],
])("shows %i ms into a meeting as %s", (offsetMs, expected) => {
  expect(transcriptTime(offsetMs)).toBe(expected);
});
