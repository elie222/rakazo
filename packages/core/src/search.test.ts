import type { SearchHit } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeSearchHits,
  escapeJsonSearchWildcards,
  escapeSearchWildcards,
  extractLinksFromText,
  matchesSearchQuery,
  searchHitListKey,
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

  it("escapes the characters a SQL LIKE pattern treats as wildcards", () => {
    expect(escapeSearchWildcards("50% off")).toBe("50\\% off");
    expect(escapeSearchWildcards("under_score")).toBe("under\\_score");
    expect(escapeSearchWildcards("back\\slash")).toBe("back\\\\slash");
  });

  it("leaves a query without wildcards untouched", () => {
    expect(escapeSearchWildcards("venue")).toBe("venue");
    expect(escapeSearchWildcards("")).toBe("");
  });

  it.each([
    [String.raw`back\slash`, String.raw`back\\\\slash`],
    ['say "hi"', String.raw`say \\"hi\\"`],
    ["50%_off", String.raw`50\%\_off`],
    ["line\nbreak", String.raw`line\\nbreak`],
    ["venue", "venue"],
    ["café/東京", "café/東京"],
    ["\b\f\r\t\u0001", String.raw`\\b\\f\\r\\t\\u0001`],
  ])("escapes %j for a JSONB text LIKE pattern", (query, expected) => {
    expect(escapeJsonSearchWildcards(query)).toBe(expected);
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

function link(url: string, messageId = "message-1"): SearchHit {
  return {
    kind: "link",
    botId: "bot-1",
    botName: "Scout",
    title: url,
    snippet: "match",
    messageId,
    seq: 4,
    url,
  };
}

function file(artifactId: string): SearchHit {
  return {
    kind: "file",
    botId: "bot-1",
    botName: "Scout",
    title: `${artifactId}.png`,
    snippet: "image/png · 10 bytes",
    messageId: "message-1",
    seq: 4,
    artifactId,
  };
}

describe("searchHitListKey", () => {
  it("keeps two links from the same message distinct", () => {
    const first = link("https://example.com/a");
    const second = link("https://example.com/b");
    expect(searchHitListKey(first)).not.toBe(searchHitListKey(second));
    expect(dedupeSearchHits([first, second, first])).toEqual([first, second]);
  });

  it("keeps two files sent in the same message distinct", () => {
    const first = file("artifact-1");
    const second = file("artifact-2");
    expect(searchHitListKey(first)).not.toBe(searchHitListKey(second));
    expect(dedupeSearchHits([first, second])).toEqual([first, second]);
  });

  it("drops a repeated hit", () => {
    const hit = link("https://example.com/a");
    expect(dedupeSearchHits([hit, { ...hit }])).toEqual([hit]);
  });
});
