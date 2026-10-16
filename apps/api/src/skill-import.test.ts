import { describe, expect, it } from "vitest";
import { findCreatorSkillUrl } from "./skill-import.js";

describe("creator skill imports", () => {
  it("ignores malformed results and unrelated repositories before the exact match", () => {
    const match = "https://github.com/Example/Recipes/blob/main/SKILL.md";
    expect(
      findCreatorSkillUrl(
        [
          null,
          {},
          { githubUrl: 42 },
          { githubUrl: "not a URL" },
          { githubUrl: "https://example.test/example/recipes" },
          { githubUrl: "https://github.com/example/other" },
          { githubUrl: "https://github.com/other/recipes" },
          { githubUrl: "https://github.com/example/recipes-extra" },
          { githubUrl: "http://github.com/example/recipes" },
          { githubUrl: "https://user:pass@github.com/example/recipes" },
          { githubUrl: match },
        ],
        "example",
        "recipes",
      )?.href,
    ).toBe(match);
  });
  it.each([undefined, {}, [], [{ githubUrl: "https://github.com/other/recipes" }]])(
    "returns no match for %j",
    (skills) => {
      expect(findCreatorSkillUrl(skills, "example", "recipes")).toBeUndefined();
    },
  );
});
