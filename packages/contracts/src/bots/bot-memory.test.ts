import { describe, expect, it } from "vitest";
import { isEmptyBotMemory, memoryDocumentName, memoryNotesPreview } from "./bot-memory.js";

describe("empty bot memory", () => {
  it.each(["", " \n\t", "# Fixture\n\n", "# Original name\n\n"])(
    "hides an empty or untouched index: %j",
    (content) => {
      expect(isEmptyBotMemory({ path: "MEMORY.md", content })).toBe(true);
    },
  );
  it.each([
    { path: "MEMORY.md", content: "# Fixture\n\nA remembered fact.\n" },
    { path: "MEMORY.md", content: "# A deliberate heading" },
    { path: "notes.md", content: "# Fixture\n\n" },
  ])("preserves authored content: %j", (doc) => {
    expect(isEmptyBotMemory(doc)).toBe(false);
  });
});

describe("memory document names", () => {
  it("gives the main notes no file name and drops the extension from others", () => {
    expect(memoryDocumentName("MEMORY.md")).toBeNull();
    expect(memoryDocumentName("projects.md")).toBe("projects");
    expect(memoryDocumentName("people/team.md")).toBe("team");
  });

  it("previews the first note, past any heading", () => {
    expect(memoryNotesPreview("# Fixture\n\nPrefers short replies.\nSecond note.\n")).toBe(
      "Prefers short replies.",
    );
    expect(memoryNotesPreview("# Fixture\n\n")).toBe("");
  });
});
