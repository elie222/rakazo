import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blogOgPage } from "./blog/og";
import { ogPages, ogPublicPath } from "./og-pages";

const publicDir = join(import.meta.dirname, "../public");

describe("ogPages", () => {
  it("has a rendered image for every page, every blog post included", () => {
    const missing = ogPages()
      .map((page) => ogPublicPath(page.id))
      .filter((path) => !existsSync(join(publicDir, path)));
    expect(missing, "run scripts/render-og.mjs with these ids").toEqual([]);
  });
});

describe("blogOgPage", () => {
  it("prefers the short Open Graph title and labels the category", () => {
    const markdown = [
      "---",
      'title: "A long title: with a colon"',
      'ogTitle: "Short"',
      'category: "guides"',
      "---",
      "",
    ].join("\n");
    expect(blogOgPage("post", markdown)).toEqual({
      id: "blog-post",
      kicker: "Guide",
      title: "Short",
    });
    expect(blogOgPage("post", markdown.replace(/ogTitle.*\n/, ""))).toEqual({
      id: "blog-post",
      kicker: "Guide",
      title: "A long title: with a colon",
    });
  });
});
