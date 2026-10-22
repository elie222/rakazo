import { describe, expect, it } from "vitest";
import { findCreatorSkillUrl, githubSkillContentUrl } from "./skill-import.js";

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
  it("prefers skill matching skillPathSlug but falls back to first repository match", () => {
    const skills = [
      { githubUrl: "https://github.com/example/recipes/tree/main/skills/baking" },
      { githubUrl: "https://github.com/example/recipes/tree/main/skills/cooking" },
    ];
    expect(
      findCreatorSkillUrl(skills, "example", "recipes", "cooking")?.href,
    ).toBe("https://github.com/example/recipes/tree/main/skills/cooking");
    expect(
      findCreatorSkillUrl(skills, "example", "recipes", "grilling")?.href,
    ).toBe("https://github.com/example/recipes/tree/main/skills/baking");
  });
  it.each([undefined, {}, [], [{ githubUrl: "https://github.com/other/recipes" }]])(
    "returns no match for %j",
    (skills) => {
      expect(findCreatorSkillUrl(skills, "example", "recipes")).toBeUndefined();
    },
  );
});

describe("GitHub skill content URLs", () => {
  it("leaves repository default-branch resolution to GitHub instead of assuming main", () => {
    const url = githubSkillContentUrl(new URL("https://github.com/example/recipes/"));
    expect(url.href).toBe("https://api.github.com/repos/example/recipes/contents/SKILL.md");
    expect(url.searchParams.has("ref")).toBe(false);
  });
  it.each([
    [
      "https://github.com/example/recipes/blob/master/SKILL.md",
      "https://raw.githubusercontent.com/example/recipes/master/SKILL.md",
    ],
    [
      "https://github.com/example/recipes/tree/release/nested/",
      "https://raw.githubusercontent.com/example/recipes/release/nested/SKILL.md",
    ],
    [
      "https://github.com/tree/recipes/blob/main/SKILL.md",
      "https://raw.githubusercontent.com/tree/recipes/main/SKILL.md",
    ],
    [
      "https://example.test/github.com/example/recipes",
      "https://example.test/github.com/example/recipes",
    ],
    ["http://github.com/example/recipes", "http://github.com/example/recipes"],
    [
      "https://user:pass@github.com/example/recipes",
      "https://user:pass@github.com/example/recipes",
    ],
  ])("rewrites only supported GitHub paths: %s", (source, expected) => {
    expect(githubSkillContentUrl(new URL(source)).href).toBe(expected);
  });
});
