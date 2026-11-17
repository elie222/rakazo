import { describe, expect, it } from "vitest";
import { previousMessageAt } from "./run-assembly-context.js";

describe("previousMessageAt", () => {
  it("takes the latest message before the current turn", () => {
    const history = [
      { id: "a", createdAt: "2026-11-11T21:40:00.000Z" },
      { id: "b", createdAt: "2026-11-11T21:42:00.000Z" },
      { id: "now", createdAt: "2026-11-12T08:54:00.000Z" },
    ];
    expect(previousMessageAt(history, "now")?.toISOString()).toBe("2026-11-11T21:42:00.000Z");
  });

  it("is undefined for a first message", () => {
    expect(previousMessageAt([{ id: "now", createdAt: "2026-11-12T08:54:00.000Z" }], "now")).toBe(
      undefined,
    );
  });
});
