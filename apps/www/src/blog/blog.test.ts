import { describe, expect, it } from "vitest";
import {
  categoryFromFrontmatter,
  categoryIsIndexed,
  categoryIsIndexedAtCount,
  isIndexedPath,
} from "./indexability";

describe("sitemap indexability", () => {
  it("reads a category from frontmatter and ignores one written in the body", () => {
    const post = (category: string, body = "") => `---\ncategory: ${category}\n---\n${body}`;
    expect(categoryFromFrontmatter(post('"roundups"'))).toBe("roundups");
    expect(categoryFromFrontmatter(post("roundups"))).toBe("roundups");
    expect(categoryFromFrontmatter(post("'guides'"))).toBe("guides");
    expect(categoryFromFrontmatter(post('"nope"'))).toBeUndefined();
    expect(categoryFromFrontmatter(post("guides # setup articles", "category: roundups"))).toBe(
      "guides",
    );
    expect(categoryFromFrontmatter("---\ntitle: Hi\n---\ncategory: roundups\n")).toBeUndefined();
  });

  it("keeps a category page out of the sitemap until it has three posts", () => {
    expect(categoryIsIndexedAtCount(2)).toBe(false);
    expect(categoryIsIndexedAtCount(3)).toBe(true);
    expect(isIndexedPath("/blog/roundups/")).toBe(categoryIsIndexed("roundups"));
    expect(isIndexedPath("/blog/roundups")).toBe(categoryIsIndexed("roundups"));
  });

  it("drops XML URLs from the sitemap and keeps other pages", () => {
    expect(isIndexedPath("/blog/rss.xml")).toBe(false);
    expect(isIndexedPath("/sitemap-index.xml/")).toBe(false);
    expect(isIndexedPath("/blog/not-a-real-post/")).toBe(true);
  });
});
