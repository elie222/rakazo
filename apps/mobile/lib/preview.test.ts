import { describe, expect, it } from "vitest";
import { previewSnippet } from "./preview.js";

describe("previewSnippet", () => {
  it("keeps a short last message as a single plain line", () => {
    expect(previewSnippet("venue booked, contract sent")).toBe("venue booked, contract sent");
  });

  it("strips markdown and collapses a long last message to the first words", () => {
    const lastMessage = [
      "Done! ✅",
      "",
      "The inbox is **completely empty** and those drafts were **permanently deleted**.",
      "",
      "- 🗓️ **alex@example.com**",
      "- follow-up parked",
      "",
      "No data was lost.",
    ].join("\n");

    expect(previewSnippet(lastMessage)).toBe(
      "Done! ✅ The inbox is completely empty and those drafts were permanently",
    );
  });

  it("turns links, lists, and headings into readable words", () => {
    expect(previewSnippet("# Status\n- see [the report](https://example.com)")).toBe(
      "Status see the report",
    );
  });

  it("returns an empty snippet when there is no message text", () => {
    expect(previewSnippet("")).toBe("");
    expect(previewSnippet("   **  **   ")).toBe("");
  });
});
