import { expect, it } from "vitest";
import { shownOpenWork } from "./open-work-list.js";

const item = (id: string, status = "open") => ({ id, status });

it("shows the first five open items and keeps parked ones behind Show more", () => {
  const items = [item("parked", "parked"), ...["a", "b", "c", "d", "e", "f"].map((id) => item(id))];
  expect(shownOpenWork(items, false).map(({ id }) => id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(shownOpenWork(items, true).map(({ id }) => id)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "parked",
  ]);
  expect(shownOpenWork([item("parked", "parked")], false)).toEqual([]);
});
