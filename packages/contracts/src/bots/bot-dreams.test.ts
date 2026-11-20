import { describe, expect, it } from "vitest";
import { MemoryDreamSchema } from "./bot-memory.js";

describe("MemoryDreamSchema", () => {
  it("carries what the Memory page lists", () => {
    expect(
      MemoryDreamSchema.parse({
        id: "dream-1",
        status: "completed",
        summary: "Moved to Lisbon.",
        changedPaths: ["MEMORY.md"],
        errorKind: null,
        startedAt: "2026-02-02T23:30:00.000Z",
        finishedAt: "2026-02-02T23:31:00.000Z",
        createdAt: "2026-02-02T23:30:00.000Z",
      }),
    ).toMatchObject({ status: "completed", summary: "Moved to Lisbon." });
  });

  it("reads a row written before reasons existed as idle", () => {
    expect(
      MemoryDreamSchema.parse({
        id: "dream-1",
        status: "completed",
        summary: null,
        changedPaths: [],
        errorKind: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-02-02T23:30:00.000Z",
      }).reason,
    ).toBe("idle");
  });

  it("refuses an unknown status", () => {
    expect(
      MemoryDreamSchema.safeParse({
        id: "dream-1",
        status: "running",
        summary: null,
        changedPaths: [],
        errorKind: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-02-02T23:30:00.000Z",
      }).success,
    ).toBe(false);
  });
});
