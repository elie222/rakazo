import { describe, expect, it } from "vitest";
import { buildPotooRoutinePrompt, detectPotooFlight } from "./routine.js";

describe("potoo routine", () => {
  it("embeds the beat brief and assignment in the routine prompt", () => {
    const prompt = buildPotooRoutinePrompt("Beat brief.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "investigation",
    });
    expect(prompt).toContain("Beat brief.");
    expect(prompt).toContain("Tonight's assignment.");
  });

  it("detects patrol flights at 0.2", () => {
    const prompt = buildPotooRoutinePrompt("Beat.", {
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      beatName: "bug-fix",
    });
    expect(detectPotooFlight(prompt)?.temperature).toBe(0.2);
  });

  it("detects escalation flights at 0.3", () => {
    const flight = detectPotooFlight("Reporter's filing:\n\n{}");
    expect(flight?.temperature).toBe(0.3);
    expect(flight?.systemPrefix).toContain("House rules");
  });

  it("ignores ordinary prompts", () => {
    expect(detectPotooFlight("hello, write a poem")).toBeNull();
  });

  it("detects repair flights with the original temperature", () => {
    expect(detectPotooFlight("[potoo-repair: patrol]\nfile it")?.temperature).toBe(0.2);
    expect(detectPotooFlight("[potoo-repair: escalation]\nfile it")?.temperature).toBe(0.3);
  });
});
