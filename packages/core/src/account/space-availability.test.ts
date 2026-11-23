import { expect, it } from "vitest";
import { reachesOtherSpaces } from "./space-availability.js";

it("reaches other spaces only when the account has several and the item is in more than one", () => {
  const everywhere = { allSpaces: true, spaceIds: ["a"] };
  const two = { allSpaces: false, spaceIds: ["a", "b"] };
  const one = { allSpaces: false, spaceIds: ["a"] };
  expect(reachesOtherSpaces(everywhere, 2)).toBe(true);
  expect(reachesOtherSpaces(two, 2)).toBe(true);
  expect(reachesOtherSpaces(one, 2)).toBe(false);
  expect(reachesOtherSpaces(everywhere, 1)).toBe(false);
  expect(reachesOtherSpaces(undefined, 3)).toBe(false);
});
