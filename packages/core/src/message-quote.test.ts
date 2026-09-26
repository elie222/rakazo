import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { deriveMessageQuote, visibleTextFromMarkdown } from "./message-quote.js";

const textBlock = (text: string): MessageBlock[] => [{ kind: "text", text }];

describe("visibleTextFromMarkdown", () => {
  it("uses rendered GFM text rather than Markdown source syntax", () => {
    expect(
      visibleTextFromMarkdown(
        "## Status\n\n1. Review **the diff**\n2. Read [docs](https://example.test/a_(b))",
      ),
    ).toBe("Status\nReview the diff\nRead docs");
  });

  it("keeps literal code content but drops fence metadata", () => {
    expect(visibleTextFromMarkdown("```text\nalpha\n---\nomega\n```")).toBe("alpha\n---\nomega\n");
  });
});

describe("deriveMessageQuote", () => {
  it.each([
    ["formatted text", "we saw **42%** growth", "42% growth", "42% growth"],
    [
      "ordered lists",
      "1. Review the diff\n2. Run the tests",
      "Review the diff\nRun the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized lists",
      "1) Review the diff\n2) Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "blockquoted lists",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff Run the tests",
      "Review the diff\nRun the tests",
    ],
    ["tables", "| Name | Value |\n| --- | ---: |\n| Alice | 5 |", "Alice 5", "Alice 5"],
    ["inline code", "Run `pnpm test` now", "pnpm test", "pnpm test"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()", "2. restart()"],
    ["indented code", "    2. restart()", "2. restart()", "2. restart()"],
    ["escaped punctuation", String.raw`C\+\+ is useful`, "C++ is useful", "C++ is useful"],
    [
      "nested link destinations",
      "See [docs](https://example.test/a_(b)) next",
      "docs next",
      "docs next",
    ],
    [
      "reference links",
      "Read [the guide][g] next\n\n[g]: https://example.test",
      "the guide next",
      "the guide next",
    ],
    [
      "autolinks",
      "Open <https://example.test/a_(b)> now",
      "https://example.test/a_(b)",
      "https://example.test/a_(b)",
    ],
    ["entities", "Copyright &copy; and &#x1F600;", "Copyright © and 😀", "Copyright © and 😀"],
  ])("derives quotes from rendered %s", (_name, markdown, hint, expected) => {
    expect(deriveMessageQuote(textBlock(markdown), hint, "markdown")).toBe(expected);
  });

  it.each([
    ["C++ is fast", "C is fast"],
    ["key:value pairs", "key value pairs"],
    ["version 1.2", "version 12"],
    ["```text\nalpha\n---\nomega\n```", "alpha omega"],
    ["```text\nbody\n```", "text"],
    ["Read [docs](https://example.test/private)", "https://example.test/private"],
    ["Alice", "alice"],
  ])("rejects text that is not visibly present in %s", (markdown, hint) => {
    expect(deriveMessageQuote(textBlock(markdown), hint, "markdown")).toBeUndefined();
  });

  it("persists the canonical server slice rather than client whitespace", () => {
    expect(
      deriveMessageQuote(
        textBlock("1. Review the diff\n2. Run the tests"),
        "Review the diff Run the tests",
        "markdown",
      ),
    ).toBe("Review the diff\nRun the tests");
  });

  it("keeps markup literal for plain-text message roles", () => {
    expect(
      deriveMessageQuote(
        textBlock("Use **literal emphasis** and `literal code`"),
        "**literal emphasis** and `literal code`",
        "plain-text",
      ),
    ).toBe("**literal emphasis** and `literal code`");
  });

  it("does not derive quotes from structured message blocks", () => {
    const blocks: MessageBlock[] = [{ kind: "card", lines: [{ k: "Secret", v: "value" }] }];
    expect(deriveMessageQuote(blocks, "Secret value", "markdown")).toBeUndefined();
  });

  it("does not join text across separate rendered regions", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "alpha" },
      { kind: "card", lines: [{ k: "Status", v: "between" }] },
      { kind: "text", text: "beta" },
    ];
    expect(deriveMessageQuote(blocks, "alpha beta", "markdown")).toBeUndefined();
  });

  it("declines oversized parent text before parsing it", () => {
    expect(
      deriveMessageQuote(textBlock(`needle${"x".repeat(100_000)}`), "needle", "markdown"),
    ).toBeUndefined();
  });

  it("sees the same table-cell text the web renderer shows", () => {
    // ChatMarkdown salvages <br> and <img alt> text inside cells; a selection of
    // that rendered text must still match the canonical excerpt.
    const blocks = textBlock("| A | B |\n| --- | --- |\n| one<br>two | <img src=x alt='chart'> |");
    expect(deriveMessageQuote(blocks, "one two", "markdown")).toBe("one two");
    expect(deriveMessageQuote(blocks, "chart", "markdown")).toBe("chart");
  });

  it("truncates a whitespace-heavy excerpt to the cap instead of dropping it", () => {
    // 1000 single-char tokens survive the normalized hint, but their source
    // slice keeps the blank lines and cleans to more than the cap.
    const parent = Array.from({ length: 1200 }, () => "a").join("\n\n\n");
    const hint = Array.from({ length: 1200 }, () => "a").join(" ");
    const quote = deriveMessageQuote(textBlock(parent), hint, "markdown");
    expect(quote).toBeDefined();
    expect(quote?.length).toBe(REPLY_QUOTE_MAX_LENGTH);
  });

  it("does not split a surrogate pair when the hint hits the cap", () => {
    const parent = "a".repeat(REPLY_QUOTE_MAX_LENGTH - 1);
    const quote = deriveMessageQuote(textBlock(parent), `${parent}😀`, "markdown");
    expect(quote).toBe(parent);
  });
});
