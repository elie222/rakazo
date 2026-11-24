import { describe, expect, it } from "vitest";
import { homeVersionChoices } from "./home-versions.js";

describe("homeVersionChoices", () => {
  it("labels each version with its save time in the given locale", () => {
    const savedAt = "2026-11-02T10:30:00.000Z";
    const expected = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(savedAt));
    expect(homeVersionChoices([{ id: "r1", savedAt }], "en-US")).toEqual([
      { key: "r1", label: expected },
    ]);
  });
});
