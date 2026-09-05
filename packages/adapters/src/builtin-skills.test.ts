import { parseSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

describe("built-in agent skills", () => {
  it("ships a valid review-only Interrogate recipe", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((entry) => entry.name === "Interrogate");
    expect(skill).toBeDefined();

    const parsed = parseSkillMd(skill!.content);
    expect(parsed).not.toHaveProperty("error");
    if ("error" in parsed) throw new Error(parsed.error);

    expect(parsed).toMatchObject({
      name: "Interrogate",
      description: skill!.description,
    });
    expect(parsed.body).toContain("Do not modify files, apply fixes, push, approve, merge");
    expect(parsed.body).toContain("correctness, invariants, and boundary conditions");
    expect(parsed.body).toContain("security, privacy, authorization, and untrusted input");
    expect(parsed.body).toContain("Synthesize one verdict");
    expect(parsed.body).toContain("Do not produce or apply a patch");
  });

  it("keeps built-in names unique and within persisted skill limits", () => {
    const names = BUILTIN_AGENT_SKILLS.map((skill) => skill.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const skill of BUILTIN_AGENT_SKILLS) {
      expect(skill.name.length).toBeLessThanOrEqual(80);
      expect(skill.description.length).toBeLessThanOrEqual(2_000);
      expect(skill.content.length).toBeLessThanOrEqual(100_000);
    }
  });
});
