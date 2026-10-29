import { describe, expect, it } from "vitest";
import { formatSharedSpaceNote } from "./shared-space-note.js";

describe("formatSharedSpaceNote", () => {
  it("names the members and whose accounts the turn uses", () => {
    expect(formatSharedSpaceNote(["Ada", "Bob"], "Bob")).toBe(
      "This space is shared by Ada, Bob. Everyone in it can read this chat and your memory. This turn uses Bob's connected accounts. Share what you find in them only as far as Bob asks.",
    );
  });

  it("omits the accounts line when the requester is unknown", () => {
    expect(formatSharedSpaceNote(["Ada", "Bob"])).toBe(
      "This space is shared by Ada, Bob. Everyone in it can read this chat and your memory.",
    );
  });
});
