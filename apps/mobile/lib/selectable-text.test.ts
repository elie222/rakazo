import { describe, expect, it } from "vitest";
import { selectableTextFromMarkdown } from "./selectable-text";

describe("selectableTextFromMarkdown", () => {
  it("strips markup but keeps paragraphs, list items and numbering", () => {
    const source =
      "## Title\n\nSome **bold** and `code` with [a link](https://example.test).\n\n- one\n- two\n\n1. first\n2. second";
    expect(selectableTextFromMarkdown(source)).toBe(
      "Title\n\nSome bold and code with a link.\n\n• one\n• two\n\n1. first\n2. second",
    );
  });

  it("indents nested list items", () => {
    expect(selectableTextFromMarkdown("- a\n  - b")).toBe("• a\n  • b");
  });

  it("keeps fenced code verbatim, including indentation, markup and blank lines", () => {
    expect(
      selectableTextFromMarkdown("Run:\n\n```sh\n  echo **x**\n\n\n  echo y\n```\n\nDone."),
    ).toBe("Run:\n\n  echo **x**\n\n\n  echo y\n\nDone.");
  });

  it("closes a fence only on a matching, long-enough marker", () => {
    const source = "````md\n```\n**kept**\n````\n\nafter **bold**";
    expect(selectableTextFromMarkdown(source)).toBe("```\n**kept**\n\nafter bold");
    expect(selectableTextFromMarkdown("```\n~~~\n**kept**\n```")).toBe("~~~\n**kept**");
  });

  it("keeps an unterminated fence's remaining lines as code", () => {
    expect(selectableTextFromMarkdown("```\n  a **b**")).toBe("  a **b**");
  });

  it("keeps indented code blocks verbatim, minus the code indent", () => {
    expect(
      selectableTextFromMarkdown("Example:\n\n    def f():\n        return **1**\n\nDone"),
    ).toBe("Example:\n\ndef f():\n    return **1**\n\nDone");
  });

  it("does not treat an indented list continuation as code", () => {
    expect(selectableTextFromMarkdown("- item\n\n    more **text**")).toBe("• item\n\nmore text");
  });

  it("drops the separator after a table header but keeps later dash-only rows", () => {
    expect(selectableTextFromMarkdown("| a | b |\n| --- | --- |\n| - | - |")).toBe("a | b\n- | -");
  });

  it("keeps escaped pipes and pipes inside code spans within their cell", () => {
    expect(selectableTextFromMarkdown("| a\\|b | c |")).toBe("a|b | c");
    expect(selectableTextFromMarkdown("| `x|y` | c |")).toBe("x|y | c");
  });

  it("drops a separator only after a table's header row", () => {
    expect(selectableTextFromMarkdown("| a | b |\n| --- | --- |\n| - | - |\n| - | - |")).toBe(
      "a | b\n- | -\n- | -",
    );
    // Two dash-only rows in a row are a header and its separator, per GFM.
    expect(selectableTextFromMarkdown("| - | - |\n| - | - |")).toBe("- | -");
    expect(selectableTextFromMarkdown("| a | b |\n| - | - |")).toBe("a | b");
  });

  it("stays fast on a long line that almost looks like a table separator", () => {
    const start = performance.now();
    const text = selectableTextFromMarkdown(`| a |\n| - ${" ".repeat(99_000)}X`);
    expect(performance.now() - start).toBeLessThan(500);
    expect(text).toContain("X");
  });

  it("starts a new table after a code block", () => {
    const source = "| a | b |\n| --- | --- |\n```\ncode\n```\n| c | d |\n| --- | --- |";
    expect(selectableTextFromMarkdown(source)).toBe("a | b\ncode\nc | d");
  });

  it("drops horizontal rules but keeps a lone hyphen", () => {
    expect(selectableTextFromMarkdown("a\n\n---\n\nb")).toBe("a\n\nb");
    expect(selectableTextFromMarkdown("a\n-\nb")).toBe("a\n-\nb");
    expect(selectableTextFromMarkdown("a\n--\nb")).toBe("a\n--\nb");
  });

  it("does not truncate a very long line", () => {
    const longLine = `${"word ".repeat(5_000)}the end`;
    expect(selectableTextFromMarkdown(`${longLine}\n\nsecond`)).toContain("the end\n\nsecond");
  });

  it("does not truncate long replies", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} with some words.`).join("\n\n");
    expect(selectableTextFromMarkdown(long)).toContain("Line 399 with some words.");
  });

  it("collapses blank lines outside code only", () => {
    expect(selectableTextFromMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });
});
