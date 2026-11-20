import { describe, expect, it } from "vitest";
import { memoryDreamPrompt } from "./memory-dream.prompt.js";

const base = {
  botName: "Scout",
  includeOwn: true,
  includeShared: true,
  ownMemory: "# Scout\n\nLikes tea.",
  sharedMemory: [],
  messages: [],
};

describe("memoryDreamPrompt", () => {
  it("forbids new facts on a tidy", () => {
    const prompt = memoryDreamPrompt({ ...base, reason: "tidy" });
    expect(prompt).toContain("never add a fact that is not already there");
    expect(prompt).not.toContain("Keep only facts the user stated in these messages");
  });

  it("dates a review with the owner's local day", () => {
    const prompt = memoryDreamPrompt({
      ...base,
      reason: "review",
      reviewDate: { day: "2026-02-03", timezone: "Europe/Lisbon" },
    });
    expect(prompt).toContain("Today is 2026-02-03 in Europe/Lisbon.");
    expect(prompt).toContain("will visit Oslo in May");
    expect(prompt).not.toContain("Keep only facts the user stated in these messages");
  });

  it("consolidates new messages without dating the notes", () => {
    const prompt = memoryDreamPrompt({ ...base, reason: "idle" });
    expect(prompt).toContain("Keep only facts the user stated in these messages");
    expect(prompt).not.toContain("Today is");
  });
});
