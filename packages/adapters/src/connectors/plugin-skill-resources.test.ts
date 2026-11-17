import { describe, expect, it } from "vitest";
import { referencedSkillResources } from "./plugin-skill-resources.js";

describe("referencedSkillResources", () => {
  it("resolves relative directory links and custom companion links", () => {
    expect(
      referencedSkillResources(
        "[references](./references/) Read {baseDir}/docs/api.md and [README](README).",
        ["references/one.md", "docs/api.md", "README", "src/unrelated.ts"],
      ),
    ).toEqual(["references/one.md", "docs/api.md", "README"]);
  });
  it("does not require unrelated assets when a baseDir file is referenced", () => {
    expect(
      referencedSkillResources("Read {baseDir}/references/guide.md", [
        "references/guide.md",
        "scripts/output.bin",
      ]),
    ).toEqual(["references/guide.md"]);
  });
  it("includes spaced filenames in quoted references and Markdown links", () => {
    expect(
      referencedSkillResources("Read `my guide.md` and [other](<other guide.md>).", [
        "my guide.md",
        "other guide.md",
        "unrelated.md",
      ]),
    ).toEqual(["my guide.md", "other guide.md"]);
  });
  it("does not treat parent or absolute references as local files", () => {
    expect(referencedSkillResources("Read ../shared.md and /shared.md", ["shared.md"])).toEqual([]);
    expect(referencedSkillResources("Read ./shared.md", ["shared.md"])).toEqual(["shared.md"]);
  });
  it("preserves punctuation within resource names", () => {
    expect(
      referencedSkillResources("Read references/foo(bar).md and `references/run!`", [
        "references/foo(bar).md",
        "references/run!",
      ]),
    ).toEqual(["references/foo(bar).md", "references/run!"]);
  });
  it("matches URL-encoded filenames without changing path ownership", () => {
    expect(
      referencedSkillResources("[guide](docs/my%20guide.md#setup)", [
        "docs/my guide.md",
        "unrelated.md",
      ]),
    ).toEqual(["docs/my guide.md"]);
  });
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
