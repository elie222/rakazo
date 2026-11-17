import { expect, it } from "vitest";
import { spaceChangesFor } from "./space-change-procedures.js";

it("signals pages after everything that changes who can open a page or removes one", () => {
  for (const path of [
    ["pages", "setVisibility"],
    ["pages", "rename"],
    ["pages", "remove"],
    ["bots", "remove"],
    ["groups", "remove"],
  ]) {
    expect(spaceChangesFor(path)).toContain("pages");
  }
  expect(spaceChangesFor(["pages", "list"])).toEqual([]);
});
