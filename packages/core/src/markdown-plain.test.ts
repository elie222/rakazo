import { describe, expect, it } from "vitest";
import { plainTextFromMarkdown, truncatedPlainText } from "./markdown-plain.js";

describe("plainTextFromMarkdown", () => {
  it("drops emphasis markers", () => {
    expect(plainTextFromMarkdown("Created **Projects-CoS** as a **Project**")).toBe(
      "Created Projects-CoS as a Project",
    );
  });

  it("keeps link labels and heading or list words", () => {
    expect(plainTextFromMarkdown("# Status\n- see [the report](https://example.com)")).toBe(
      "Status see the report",
    );
  });

  it("keeps the label of a link whose destination contains parentheses", () => {
    expect(plainTextFromMarkdown("See [docs](https://example.com/a_(b)) next")).toBe(
      "See docs next",
    );
    expect(plainTextFromMarkdown("![plot](https://example.com/a_(b_(c)))")).toBe("plot");
  });

  it("keeps CommonMark autolink text", () => {
    expect(plainTextFromMarkdown("<https://example.com>")).toBe("https://example.com");
    expect(plainTextFromMarkdown("Open <https://example.com/a_(b)> now")).toBe(
      "Open https://example.com/a_(b) now",
    );
    expect(plainTextFromMarkdown("<user@example.com>")).toBe("user@example.com");
  });

  it("keeps inline code contents", () => {
    expect(plainTextFromMarkdown("Use `pnpm test` first")).toBe("Use pnpm test first");
  });

  it("does not strip Markdown that lives inside code", () => {
    expect(plainTextFromMarkdown("Use `<tag>` here")).toBe("Use <tag> here");
    expect(plainTextFromMarkdown("Keep `*x*` and `[label](url)`")).toBe(
      "Keep *x* and [label](url)",
    );
    expect(plainTextFromMarkdown("```\nuse <https://example.com> and *y*\n```")).toBe(
      "use <https://example.com> and *y*",
    );
  });

  it("collapses a fenced block and surrounding prose to one line", () => {
    expect(plainTextFromMarkdown("Done.\n\n```ts\nconst x = 1;\n```\n\nShipped.")).toBe(
      "Done. const x = 1; Shipped.",
    );
  });

  it("closes a fence only on a matching run of the opener", () => {
    expect(plainTextFromMarkdown("````\n```\nstill in the fence\n````")).toBe(
      "``` still in the fence",
    );
    expect(plainTextFromMarkdown("```\na ``` b\n```")).toBe("a ``` b");
    expect(plainTextFromMarkdown("~~~~\ncode with ~~~\nstill\n~~~~")).toBe("code with ~~~ still");
  });

  it("still finds a later link after many unmatched brackets", () => {
    const noise = "[".repeat(20_000);
    expect(plainTextFromMarkdown(`${noise} see [docs](https://example.com/a_(b))`)).toBe(
      `${noise} see docs`,
    );
  });

  it("does not treat existing private-use characters as code placeholders", () => {
    expect(plainTextFromMarkdown("\uE0000\uE000 keep `*x*`")).toBe("\uE0000\uE000 keep *x*");
    const noise = "\uE000".repeat(20_000);
    expect(plainTextFromMarkdown(`${noise} keep \`*x*\``)).toBe(`${noise} keep *x*`);
  });

  it("keeps backslash-escaped punctuation as literal text", () => {
    expect(plainTextFromMarkdown("Use \\*literal\\*")).toBe("Use *literal*");
  });

  it("returns empty when only markers remain", () => {
    expect(plainTextFromMarkdown("")).toBe("");
    expect(plainTextFromMarkdown("   **  **   ")).toBe("");
  });
});

describe("truncatedPlainText", () => {
  it("strips markers before cutting the preview", () => {
    expect(truncatedPlainText("Created **Projects-CoS** as a **Project**", 28)).toBe(
      "Created Projects-CoS as a Pr",
    );
    expect(truncatedPlainText("Created **Projects-CoS** as a **Project**", 28)).not.toContain("*");
  });

  it("does not split a supplementary character at the cut", () => {
    const preview = truncatedPlainText(`${"a".repeat(179)}\u{1F600}b`, 180);
    expect(preview).toBe("a".repeat(179));
    expect(preview).not.toMatch(/[\uD800-\uDFFF]/);
  });
});
