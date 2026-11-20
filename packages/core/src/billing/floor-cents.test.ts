import { expect, it } from "vitest";
import { floorCents } from "./floor-cents.js";

it("rounds down to the cent without float error at either side of a cent", () => {
  expect(floorCents(0.29)).toBe(0.29);
  expect(floorCents(0.289999999999)).toBe(0.28);
  expect(floorCents(0.0165)).toBe(0.01);
  expect(floorCents(0.00108)).toBe(0);
  expect(floorCents(7490.039)).toBe(7490.03);
  expect(floorCents(12)).toBe(12);
});
