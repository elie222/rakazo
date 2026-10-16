import { describe, expect, it } from "vitest";
import {
  extractLinksFromText,
  matchesSearchQuery,
  searchHitThreadTarget,
  snippetAroundMatch,
} from "./search.js";

describe("search helpers", () => {
  it("extracts http and https links from text", () => {
    expect(extractLinksFromText("see https://example.com/docs and http://test.local/x.")).toEqual([
      "https://example.com/docs",
      "http://test.local/x",
    ]);
  });

  it("keeps balanced parentheses inside a link", () => {
    expect(
      extractLinksFromText(
        "read https://en.wikipedia.org/wiki/Rust_(programming_language), or (see https://example.com/docs).",
      ),
    ).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://example.com/docs",
    ]);
    expect(extractLinksFromText("(https://example.com/a_(b)).")).toEqual([
      "https://example.com/a_(b)",
    ]);
    expect(
      extractLinksFromText("**[docs](https://example.com/docs)** and ((https://x.test/y)))"),
    ).toEqual(["https://example.com/docs", "https://x.test/y"]);
  });

  it("keeps adjacent wrapped links", () => {
    expect(extractLinksFromText("(https://example.com/a),(https://example.com/b)")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("ignores a bare scheme after an unmatched closing parenthesis", () => {
    expect(extractLinksFromText("https://example.com/docs)https://")).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("handles thousands of adjacent wrapped links without recursing", () => {
    const text = "(https://x.test/),".repeat(50_000);
    expect(extractLinksFromText(text)).toEqual(["https://x.test/"]);
  });

  it("matches case-insensitive substrings", () => {
    expect(matchesSearchQuery("Venue", "Research venues")).toBe(true);
    expect(matchesSearchQuery("missing", "Research venues")).toBe(false);
  });

  it("builds a short snippet around the query", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    expect(snippetAroundMatch(text, "gamma", 20)).toContain("gamma");
  });

  it("uses groupId for group search message jumps", () => {
    expect(searchHitThreadTarget({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
    expect(searchHitThreadTarget({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
  });

  it("rejects ambiguous search hit targets", () => {
    expect(() => searchHitThreadTarget({})).toThrow();
    expect(() => searchHitThreadTarget({ botId: "bot-1", groupId: "group-1" })).toThrow();
  });
});
