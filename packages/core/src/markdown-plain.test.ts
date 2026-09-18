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

  it("keeps inline code contents", () => {
    expect(plainTextFromMarkdown("Use `pnpm test` first")).toBe("Use pnpm test first");
  });

  it("collapses a fenced block and surrounding prose to one line", () => {
    expect(plainTextFromMarkdown("Done.\n\n```ts\nconst x = 1;\n```\n\nShipped.")).toBe(
      "Done. const x = 1; Shipped.",
    );
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
});
