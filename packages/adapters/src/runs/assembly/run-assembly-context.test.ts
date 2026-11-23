import { describe, expect, it } from "vitest";
import { previousMessageAt } from "./run-assembly-context.js";

describe("previousMessageAt", () => {
  it("takes the newest message other than the current turn, in any order", () => {
    const messages = [
      { id: "now", createdAt: new Date("2026-11-12T08:54:00Z") },
      { id: "b", createdAt: new Date("2026-11-11T21:42:00Z") },
      { id: "a", createdAt: new Date("2026-11-11T21:40:00Z") },
    ];
    expect(previousMessageAt(messages, "now")?.toISOString()).toBe("2026-11-11T21:42:00.000Z");
  });

  it("is undefined for a first message", () => {
    expect(previousMessageAt([{ id: "now", createdAt: new Date() }], "now")).toBe(undefined);
  });
});
