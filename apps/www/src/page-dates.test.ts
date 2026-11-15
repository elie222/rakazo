import { describe, expect, it } from "vitest";
import { ALTERNATIVES, ROUNDUP_UPDATED, alternativePath } from "./alternatives";
import { blogUpdatedDates, updatedFromFrontmatter } from "./blog/indexability";
import { isoFromDisplayDate, pageDate } from "./page-dates";
import { SANDBOXES, SANDBOXES_UPDATED, sandboxPath } from "./sandboxes";
import { sitemapEntry } from "./sitemap";

describe("page dates", () => {
  it("turns a shown date into an ISO date and rejects anything else", () => {
    expect(isoFromDisplayDate("October 7, 2026")).toBe("2026-10-07");
    expect(isoFromDisplayDate("November 24, 2026")).toBe("2026-11-24");
    expect(() => isoFromDisplayDate("2026-10-07")).toThrow();
    expect(() => isoFromDisplayDate("Octember 7, 2026")).toThrow();
  });

  it("dates every comparison, hub and provider page from the date it shows", () => {
    expect(pageDate("/alternatives/")).toBe(isoFromDisplayDate(ROUNDUP_UPDATED));
    for (const page of ALTERNATIVES) {
      expect(pageDate(alternativePath(page))).toBe(isoFromDisplayDate(page.comparedOn));
    }
    for (const sandbox of SANDBOXES) {
      expect(pageDate(sandboxPath(sandbox.slug))).toBe(isoFromDisplayDate(SANDBOXES_UPDATED));
    }
    expect(pageDate("/sandboxes")).toBe(pageDate("/sandboxes/"));
  });

  it("dates blog posts from their frontmatter and the blog from the newest post", () => {
    const posts = blogUpdatedDates();
    expect(posts.size).toBeGreaterThan(0);
    for (const [slug, updated] of posts) expect(pageDate(`/blog/${slug}/`)).toBe(updated);
    expect(pageDate("/blog/")).toBe([...posts.values()].sort().at(-1));
    expect(updatedFromFrontmatter('---\nupdated: "2026-10-24"\n---\n')).toBe("2026-10-24");
    expect(updatedFromFrontmatter("---\ntitle: Hi\n---\nupdated: 2026-10-24\n")).toBeUndefined();
  });

  it("leaves pages that show no date undated", () => {
    expect(pageDate("/")).toBeUndefined();
    expect(pageDate("/pricing/")).toBeUndefined();
    expect(pageDate("/self-hosted-ai-agent/")).toBeUndefined();
  });
});

describe("sitemap entries", () => {
  it("adds lastmod only to dated pages", () => {
    expect(sitemapEntry({ url: "https://rakazo.com/alternatives/" }).lastmod).toBe(
      pageDate("/alternatives/"),
    );
    expect(sitemapEntry({ url: "https://rakazo.com/pricing/" })).not.toHaveProperty("lastmod");
  });

  it("points x-default at the English version of a localized page", () => {
    const links = [
      { lang: "en-US", url: "https://rakazo.com/" },
      { lang: "de-DE", url: "https://rakazo.com/de/" },
    ];
    expect(sitemapEntry({ url: "https://rakazo.com/de/", links }).links).toEqual([
      ...links,
      { lang: "x-default", url: "https://rakazo.com/" },
    ]);
    expect(sitemapEntry({ url: "https://rakazo.com/pricing/" }).links).toBeUndefined();
  });
});
