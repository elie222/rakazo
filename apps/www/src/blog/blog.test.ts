import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALTERNATIVES } from "../alternatives";
import {
  categoryFromFrontmatter,
  categoryIsIndexed,
  categoryIsIndexedAtCount,
  isIndexedPath,
} from "./indexability";
import { ogPages } from "../og-pages";
import { vsCard } from "../vs-points";

const blogDir = join(import.meta.dirname, "../content/blog");
const ogDir = join(import.meta.dirname, "../../public/og");

function words(markdown: string): number {
  const body = markdown.replace(/^---[\s\S]*?---/, " ");
  const plain = body
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_\[\]()`]/g, " ");
  return plain.split(/\s+/).filter(Boolean).length;
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("blog posts", () => {
  const files = readdirSync(blogDir).filter((file) => file.endsWith(".md"));

  it("keeps the first posts in the essay range", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const count = words(readFileSync(join(blogDir, file), "utf8"));
      expect(count, file).toBeGreaterThanOrEqual(1500);
      expect(count, file).toBeLessThanOrEqual(3200);
    }
  });

  it("counts quoted categories and indexes a category at three posts", () => {
    const post = (category: string, body = "") => `---\ncategory: ${category}\n---\n${body}`;
    expect(categoryFromFrontmatter(post('"roundups"'))).toBe("roundups");
    expect(categoryFromFrontmatter(post("roundups"))).toBe("roundups");
    expect(categoryFromFrontmatter(post("'guides'"))).toBe("guides");
    expect(categoryFromFrontmatter(post('"nope"'))).toBeUndefined();
    expect(categoryFromFrontmatter(post("guides # setup articles", "category: roundups"))).toBe(
      "guides",
    );
    expect(categoryFromFrontmatter("---\ntitle: Hi\n---\ncategory: roundups\n")).toBeUndefined();
    expect(categoryIsIndexedAtCount(2)).toBe(false);
    expect(categoryIsIndexedAtCount(3)).toBe(true);
  });

  it("leaves category pages out of the index until each has three posts", () => {
    expect(categoryIsIndexed("roundups")).toBe(false);
    expect(categoryIsIndexed("comparisons")).toBe(false);
    expect(categoryIsIndexed("guides")).toBe(false);
    expect(categoryIsIndexed("product")).toBe(false);
    expect(isIndexedPath("/blog/roundups/")).toBe(false);
    expect(isIndexedPath("/blog/best-open-source-ai-agents-2026/")).toBe(true);
    expect(isIndexedPath("/blog/rss.xml")).toBe(false);
  });
});

describe("comparison graphics", () => {
  it("has a short card for every comparison page", () => {
    for (const page of ALTERNATIVES) {
      expect(vsCard(page.slug), page.slug).toBeDefined();
    }
    expect(vsCard("grok-bot-alternative")).toBeDefined();
    expect(vsCard("openclaw-alternative")).toBeDefined();
  });

  it("ships a 1200 by 630 image for every Open Graph page", () => {
    for (const page of ogPages()) {
      expect(pngSize(join(ogDir, `${page.id}.png`)), page.id).toEqual({
        width: 1200,
        height: 630,
      });
    }
  });
});
