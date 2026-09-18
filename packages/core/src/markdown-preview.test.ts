import { describe, expect, it } from "vitest";
import { previewText } from "./markdown-preview.js";

describe("previewText", () => {
  it("drops bold markers, matching the reported example", () => {
    expect(previewText("Created **Projects-CoS** as a **Project**")).toBe(
      "Created Projects-CoS as a Project",
    );
  });

  it("drops italic and strikethrough markers", () => {
    expect(previewText("_italic_ and __also bold__ and ~~gone~~")).toBe(
      "italic and also bold and gone",
    );
  });

  it("drops heading markers but keeps the text", () => {
    expect(previewText("## Deploy notes\nAll good")).toBe("Deploy notes All good");
  });

  it("keeps a link's label and drops its URL", () => {
    expect(previewText("See [the README](https://example.com/a/b?c=d) for more")).toBe(
      "See the README for more",
    );
  });

  it("keeps an inline code span's contents", () => {
    expect(previewText("Run `pnpm install` first")).toBe("Run pnpm install first");
  });

  it("keeps a fenced code block's contents", () => {
    expect(previewText("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("drops list and blockquote markers", () => {
    expect(previewText("- first\n- second\n> quoted")).toBe("first second quoted");
  });

  it("drops checkbox syntax", () => {
    expect(previewText("- [x] done\n- [ ] todo")).toBe("done todo");
  });

  it("collapses a table row to comma-separated cells", () => {
    expect(previewText("| a | b |\n| - | - |\n| 1 | 2 |")).toBe("a, b 1, 2");
  });

  it("returns an empty string for empty input", () => {
    expect(previewText("")).toBe("");
  });

  it("never leaves a dangling marker after the caller truncates the result", () => {
    const long = "Created **Projects-CoS** as a **Project** and more text after that";
    const clean = previewText(long);
    expect(clean).toBe("Created Projects-CoS as a Project and more text after that");
    for (let cut = 1; cut < clean.length; cut++) {
      expect(clean.slice(0, cut)).not.toContain("*");
    }
  });
});
