import { describe, expect, it } from "vitest";
import { editMemoryEntry } from "./memory-entry.js";

describe("memory entry edits", () => {
  it("changes only the selected occurrence and preserves surrounding text", () => {
    const content = "first\n\nrepeat 🙂\n\nrepeat 🙂\n\nlast";
    const start = content.lastIndexOf("repeat 🙂");
    expect(
      editMemoryEntry(content, start, start + "repeat 🙂".length, "repeat 🙂", "corrected"),
    ).toBe("first\n\nrepeat 🙂\n\ncorrected\n\nlast");
  });

  it("rejects a stale or invalid selection", () => {
    expect(() => editMemoryEntry("one\n\ntwo", 5, 8, "old", "new")).toThrow();
    expect(() => editMemoryEntry("one", -1, 3, "one", "")).toThrow();
  });

  it("rejects partial lines and selections spanning multiple entries", () => {
    expect(() => editMemoryEntry("first\nsecond", 1, 5, "irst", "new")).toThrow();
    expect(() => editMemoryEntry("first\nsecond", 0, 12, "first\nsecond", "new")).toThrow();
    expect(() => editMemoryEntry("first\nsecond", 0, 5, "first", "two\nlines")).toThrow();
  });
});
