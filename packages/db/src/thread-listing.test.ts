import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("strips Markdown syntax from the first text block", () => {
    const blocks = [{ kind: "text", text: "Created **Projects-CoS** as a **Project**" }];
    expect(previewFromBlocks(blocks)).toBe("Created Projects-CoS as a Project");
  });

  it("returns the empty string when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "progress" }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
    expect(previewFromBlocks(null)).toBe("");
  });

  it("skips non-text blocks to find the first block with text", () => {
    const blocks = [{ kind: "progress" }, { kind: "text", text: "_hello_" }];
    expect(previewFromBlocks(blocks)).toBe("hello");
  });
});
