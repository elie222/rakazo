import { describe, expect, it } from "vitest";
import { PAGE_REVISION_NOT_FOUND, pageRevisionFloor } from "./page-collaboration.js";

const refusal = (code: unknown, data: unknown) => ({ code, status: 404, data });

describe("pageRevisionFloor", () => {
  it("reads the lowest readable revision a revision-only refusal names", () => {
    expect(pageRevisionFloor(refusal(PAGE_REVISION_NOT_FOUND, { readableFrom: 3 }))).toBe(3);
  });

  it.each([
    ["another code", refusal("NOT_FOUND", { readableFrom: 3 })],
    ["no detail", refusal(PAGE_REVISION_NOT_FOUND, undefined)],
    ["another field", refusal(PAGE_REVISION_NOT_FOUND, { reason: "template_changed" })],
    [
      "a value that is not a revision number",
      refusal(PAGE_REVISION_NOT_FOUND, { readableFrom: "3" }),
    ],
    ["not an error", null],
  ])("is undefined for %s", (_case, error) => {
    expect(pageRevisionFloor(error)).toBeUndefined();
  });
});
