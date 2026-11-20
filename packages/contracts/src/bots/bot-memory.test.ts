import { describe, expect, it } from "vitest";
import {
  initialBotMemory,
  isEmptyBotMemory,
  MemoryDocumentSchema,
  MemoryRevisionSummarySchema,
} from "./bot-memory.js";

describe("empty bot memory", () => {
  it.each(["", " \n\t", initialBotMemory("Fixture"), initialBotMemory("Original name")])(
    "hides an empty or untouched index: %j",
    (content) => {
      expect(isEmptyBotMemory({ path: "MEMORY.md", content })).toBe(true);
    },
  );
  it.each([
    { path: "MEMORY.md", content: `${initialBotMemory("Fixture")}A remembered fact.\n` },
    { path: "MEMORY.md", content: "# A deliberate heading" },
    { path: "notes.md", content: initialBotMemory("Fixture") },
  ])("preserves authored content: %j", (doc) => {
    expect(isEmptyBotMemory(doc)).toBe(false);
  });
});

describe("memory revisions", () => {
  it("reads a row written before kinds existed as a person", () => {
    expect(
      MemoryRevisionSummarySchema.parse({
        id: "revision-1",
        revision: 3,
        createdAt: "2026-02-02T23:30:00.000Z",
      }).sourceKind,
    ).toBe("user");
  });

  it("refuses an unknown writer", () => {
    expect(
      MemoryRevisionSummarySchema.safeParse({
        id: "revision-1",
        revision: 3,
        sourceKind: "system",
        createdAt: "2026-02-02T23:30:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("memory document descriptions", () => {
  it("reads a note written before descriptions existed as having none", () => {
    expect(
      MemoryDocumentSchema.parse({
        id: "memory-1",
        scope: "user",
        botId: null,
        path: "MEMORY.md",
        content: "A fact",
        revision: 1,
        updatedAt: "2026-02-02T23:30:00.000Z",
      }).description,
    ).toBeNull();
  });
});
