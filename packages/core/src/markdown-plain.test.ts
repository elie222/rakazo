import { describe, expect, it, vi } from "vitest";
import { plainTextFromMarkdown, truncatedPlainText } from "./markdown-plain.js";

describe("plainTextFromMarkdown", () => {
  it("does not rebuild the placeholder pattern for each escaped character", () => {
    const markerText = "\uE000".repeat(128);
    const source = `${markerText}${"\\*".repeat(128)} <_ops_@example.test>`;
    let compiledPatterns = 0;
    vi.stubGlobal(
      "RegExp",
      new Proxy(RegExp, {
        construct(target, args) {
          compiledPatterns += 1;
          return Reflect.construct(target, args);
        },
      }),
    );
    try {
      expect(plainTextFromMarkdown(source)).toBe(
        `${markerText}${"*".repeat(128)} _ops_@example.test`,
      );
      expect(compiledPatterns).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    "Saved monthly_sales_report.csv",
    "Set DATABASE_POOL_SIZE to 12",
    "Keep foo__bar__baz unchanged",
    "Open https://example.test/monthly_sales_report",
    "Email first_middle_last@example.test",
    "保留客户_月度_报告和équipe_nom_complet",
    "Keep cafe\u0301_nom_ unchanged",
  ])("preserves underscores inside words: %s", (text) => {
    expect(plainTextFromMarkdown(text)).toBe(text);
  });

  it("still removes underscore emphasis around identifiers and punctuation", () => {
    expect(
      plainTextFromMarkdown("_one_ __two__ ___three___ (_four_) __monthly_sales_report__"),
    ).toBe("one two three (four) monthly_sales_report");
  });

  it("removes nested underscore emphasis without changing identifiers", () => {
    expect(plainTextFromMarkdown("__bold _italic_ bold__")).toBe("bold italic bold");
    expect(plainTextFromMarkdown("__bold _italic___")).toBe("bold italic");
    expect(plainTextFromMarkdown("___bold__ italic_")).toBe("bold italic");
    expect(plainTextFromMarkdown("_italic __bold__ italic_ and __monthly_sales_report__")).toBe(
      "italic bold italic and monthly_sales_report",
    );
  });

  it("preserves a long sequence of unmatched underscore openers", () => {
    const text = "_word ".repeat(100_000).trim();
    expect(plainTextFromMarkdown(text)).toBe(text);
  });

  it.each(["_one_~~two~~", "~~one~~_two_", "_one_**two**", "**one**_two_"])(
    "removes adjacent formatting without changing delimiter boundaries: %s",
    (text) => expect(plainTextFromMarkdown(text)).toBe("onetwo"),
  );

  it("does not let HTML attribute underscores steal visible emphasis", () => {
    expect(plainTextFromMarkdown('_Open <a href="/_draft">report</a> now_')).toBe(
      "Open report now",
    );
    expect(plainTextFromMarkdown('_Open <a title=">_draft">report</a> now_')).toBe(
      "Open report now",
    );
    expect(plainTextFromMarkdown('<a title="> report')).toBe("report");
    expect(plainTextFromMarkdown('_See <a title="> now_')).toBe("See now");
    expect(plainTextFromMarkdown('See <a href="x>y" title="z')).toBe("See");
  });

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

  it.each([
    ["<https://example.test/_draft_>", "https://example.test/_draft_"],
    ["<_ops_@example.test>", "_ops_@example.test"],
    ["<https://example.test/*draft*/~~old~~>", "https://example.test/*draft*/~~old~~"],
    ["**Contact** <_ops_@example.test> _today_", "Contact _ops_@example.test today"],
    ["_<https://example.test/_draft_>_", "https://example.test/_draft_"],
    ["<https://example.test/\\_draft\\_>", "https://example.test/_draft_"],
    ["`<https://example.test/_draft_>`", "<https://example.test/_draft_>"],
  ])("keeps autolink destinations literal: %s", (source, expected) => {
    expect(plainTextFromMarkdown(source)).toBe(expected);
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
