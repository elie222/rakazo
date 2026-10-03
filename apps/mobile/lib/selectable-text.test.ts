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

  it("keeps fenced code verbatim, including indentation and markup characters", () => {
    expect(selectableTextFromMarkdown("Run:\n\n```sh\n  echo **x**\n```\n\nDone.")).toBe(
      "Run:\n\n  echo **x**\n\nDone.",
    );
  });

  it("drops table separator rows and horizontal rules", () => {
    expect(selectableTextFromMarkdown("a\n\n---\n\nb")).toBe("a\n\nb");
    expect(selectableTextFromMarkdown("| a | b |\n| --- | --- |")).not.toContain("---");
  });

  it("does not truncate long replies", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} with some words.`).join("\n\n");
    expect(selectableTextFromMarkdown(long)).toContain("Line 399 with some words.");
  });
});
