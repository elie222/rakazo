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
