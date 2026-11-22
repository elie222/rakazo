import { describe, expect, it } from "vitest";
import { instructionUpdateDiff } from "./instruction-diff.js";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

describe("instructionUpdateDiff", () => {
  it("shows a line holding a redacted value as changed, since the marker may hide a real value on one side", () => {
    expect(
      instructionUpdateDiff("Be brief\nKey is [redacted]", "Be brief\nKey is [redacted]"),
    ).toBe(["  Be brief", "- Key is [redacted]", "+ Key is [redacted]"].join("\n"));
  });

  it("still shows redacted lines as changed when line endings differ", () => {
    expect(
      instructionUpdateDiff(
        "Be brief\r\nKey is [redacted]\r\nKeep context",
        "Be brief\nKey is [redacted]\nKeep context",
      ),
    ).toBe(
      ["  Be brief", "- Key is [redacted]", "+ Key is [redacted]", "  Keep context"].join("\n"),
    );
  });

  it("returns the new text when there is nothing to compare", () => {
    expect(instructionUpdateDiff("  \n", "Be brief")).toBe("Be brief");
    expect(instructionUpdateDiff("  \r\n", "Be brief\r\nAsk first")).toBe("Be brief\r\nAsk first");
  });

  it("shows only the edited line when both sides mix CRLF and LF", () => {
    expect(instructionUpdateDiff("a\r\nb\nc\r\nd", "a\nx\r\nc\nd")).toBe("  a\n- b\n+ x\n  c\n  d");
  });

  it("does not report changes when only the line endings differ", () => {
    expect(instructionUpdateDiff("a\r\n\r\nb\r\n", "a\n\nb\n")).toBe(
      ["  a", "  ", "  b", "  "].join("\n"),
    );
  });

  it("keeps a standalone carriage return and meaningful trailing whitespace distinct", () => {
    expect(instructionUpdateDiff("a\rb\r\nkeep  \n", "ab\nkeep \r\n")).toBe(
      ["- a\rb", "- keep  ", "+ ab", "+ keep ", "  "].join("\n"),
    );
  });

  it("shows a changed line with nearby context and counts the rest", () => {
    const before = numbered(40);
    const after = [...before];
    after[19] = "line 20 changed";
    expect(instructionUpdateDiff(before.join("\n"), after.join("\n"))).toBe(
      [
        "… 17 unchanged lines",
        "  line 18",
        "  line 19",
        "- line 20",
        "+ line 20 changed",
        "  line 21",
        "  line 22",
        "… 18 unchanged lines",
      ].join("\n"),
    );
  });

  it("shows a single unchanged line instead of a marker for it", () => {
    const before = numbered(9);
    const after = [...before];
    after[1] = "line 2 changed";
    after[7] = "line 8 changed";
    expect(instructionUpdateDiff(before.join("\n"), after.join("\n"))).toBe(
      [
        "  line 1",
        "- line 2",
        "+ line 2 changed",
        "  line 3",
        "  line 4",
        "  line 5",
        "  line 6",
        "  line 7",
        "- line 8",
        "+ line 8 changed",
        "  line 9",
      ].join("\n"),
    );
  });

  it("shows an appended line without repeating the old text", () => {
    expect(instructionUpdateDiff("Draft only", "Draft only\nAsk before sending")).toBe(
      "  Draft only\n+ Ask before sending",
    );
  });

  it("keeps every removed line visible, wherever it was", () => {
    const before = numbered(30);
    const after = before.filter((line) => line !== "line 3" && line !== "line 28");
    const diff = instructionUpdateDiff(before.join("\n"), after.join("\n"));
    expect(diff.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- line 3",
      "- line 28",
    ]);
    expect(diff).not.toContain("+ ");
    expect(diff).toContain("… 20 unchanged lines");
  });

  it("matches lines that moved apart instead of replacing everything between them", () => {
    expect(instructionUpdateDiff("a\nb\nc\nd\ne", "a\nx\nc\ny\ne")).toBe(
      "  a\n- b\n+ x\n  c\n- d\n+ y\n  e",
    );
  });

  it("shows a full rewrite as removals then additions", () => {
    expect(instructionUpdateDiff("Reply in English.\nBe formal.", "Answer briefly.")).toBe(
      "- Reply in English.\n- Be formal.\n+ Answer briefly.",
    );
  });

  it("shows one removal when a repeated line loses a copy", () => {
    expect(instructionUpdateDiff("a\na\nb", "a\nb")).toBe("  a\n- a\n  b");
  });

  it("shows an unchanged text whole rather than an empty diff", () => {
    expect(instructionUpdateDiff("Keep it.", "Keep it.")).toBe("  Keep it.");
  });

  it("lists every old line as removed when the new text is empty", () => {
    expect(instructionUpdateDiff("Draft only\nAsk first", "")).toBe(
      "- Draft only\n- Ask first\n+ ",
    );
  });

  it("shows a long unchanged text whole", () => {
    const text = numbered(20_000).join("\n");
    const diff = instructionUpdateDiff(text, text).split("\n");
    expect(diff).toHaveLength(20_000);
    expect(diff.every((line) => line.startsWith("  "))).toBe(true);
  });

  it("finds two small edits far apart in a long text of short lines", () => {
    const before = Array.from({ length: 9_999 }, (_, i) => String(i % 3));
    const after = [...before];
    after[1] = "x";
    after[9_997] = "y";
    expect(instructionUpdateDiff(before.join("\n"), after.join("\n"))).toBe(
      [
        "  0",
        "- 1",
        "+ x",
        "  2",
        "  0",
        "… 9991 unchanged lines",
        "  2",
        "  0",
        "- 1",
        "+ y",
        "  2",
      ].join("\n"),
    );
  });

  it("still lists every removed and added line for a very large rewrite", () => {
    const before = numbered(3000);
    const after = before.map((line) => `${line} edited`);
    const diff = instructionUpdateDiff(before.join("\n"), after.join("\n")).split("\n");
    expect(diff.filter((line) => line.startsWith("- "))).toHaveLength(3000);
    expect(diff.filter((line) => line.startsWith("+ "))).toHaveLength(3000);
  });
});
