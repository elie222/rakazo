import { expect, it } from "vitest";
import { isMarkdownPath, skillFileRows } from "./skill-file-tree";

it("lists SKILL.md first, then each folder before its files in path order", () => {
  const rows = skillFileRows([
    { path: "templates/report.html", bytes: 215 },
    { path: "RAKAZO.md", bytes: 217 },
    { path: "templates/email.html", bytes: 204 },
    { path: "references/deep/notes.md", bytes: 9 },
  ]);
  expect(rows.map((row) => [row.kind, row.name, row.depth])).toEqual([
    ["file", "SKILL.md", 0],
    ["file", "RAKAZO.md", 0],
    ["folder", "references/", 0],
    ["folder", "deep/", 1],
    ["file", "notes.md", 2],
    ["folder", "templates/", 0],
    ["file", "email.html", 1],
    ["file", "report.html", 1],
  ]);
  expect(rows.find((row) => row.kind === "file" && row.path === "templates/email.html")).toEqual(
    expect.objectContaining({ bytes: 204, key: "templates/email.html" }),
  );
});

it("shows only SKILL.md for a skill without files", () => {
  expect(skillFileRows([])).toEqual([
    { kind: "file", key: "SKILL.md", path: "SKILL.md", name: "SKILL.md", depth: 0 },
  ]);
});

it("reads markdown files as markdown and everything else verbatim", () => {
  expect(["SKILL.md", "notes.MD", "guide.mdx"].map(isMarkdownPath)).toEqual([true, true, true]);
  expect(["email.html", "rates.csv", "md"].map(isMarkdownPath)).toEqual([false, false, false]);
});
