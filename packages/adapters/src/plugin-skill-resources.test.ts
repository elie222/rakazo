import { describe, expect, it } from "vitest";
import { referencedSkillResources } from "./plugin-skill-resources.js";

describe("referencedSkillResources", () => {
  const paths = ["references/guide.md", "references/other.md", "src/main.ts"];
  it("includes a directory mentioned alongside an individual file", () => {
    expect(
      referencedSkillResources(
        "Read references/guide.md and the other files in references/.",
        paths,
      ),
    ).toEqual(paths.slice(0, 2));
  });
  it("does not expand an individual file reference to its directory", () => {
    expect(referencedSkillResources("Read references/guide.md.", paths)).toEqual([paths[0]]);
  });
});
