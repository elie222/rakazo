import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changedSince, indexNowKey, parseSitemap } from "./indexnow.mjs";

const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://rakazo.com/sitemap-0.xml</loc></sitemap><sitemap><loc>https://rakazo.com/sitemap-1.xml</loc><lastmod>2026-11-01</lastmod></sitemap></sitemapindex>`;

const urlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://rakazo.com/</loc>
    <xhtml:link rel="alternate" hreflang="de-DE" href="https://rakazo.com/de/"/>
    <image:image><image:loc>https://rakazo.com/og-image.png</image:loc></image:image>
    <lastmod>2026-11-15T22:41:00.000Z</lastmod>
  </url>
  <url><loc>https://rakazo.com/blog/old</loc><lastmod>2026-10-01</lastmod></url>
  <url><loc>https://rakazo.com/search?q=a&amp;b=c</loc><lastmod>2026-11-16</lastmod></url>
  <url><loc>https://rakazo.com/no-lastmod</loc></url>
  <url><loc>https://example.com/elsewhere</loc><lastmod>2026-11-16</lastmod></url>
</urlset>`;

describe("parseSitemap", () => {
  it("lists the child sitemaps of an index", () => {
    expect(parseSitemap(sitemapIndex)).toEqual({
      sitemaps: ["https://rakazo.com/sitemap-0.xml", "https://rakazo.com/sitemap-1.xml"],
      urls: [],
    });
  });

  it("reads each page's own loc and lastmod, decoding entities", () => {
    expect(parseSitemap(urlset)).toEqual({
      sitemaps: [],
      urls: [
        { loc: "https://rakazo.com/", lastmod: "2026-11-15T22:41:00.000Z" },
        { loc: "https://rakazo.com/blog/old", lastmod: "2026-10-01" },
        { loc: "https://rakazo.com/search?q=a&b=c", lastmod: "2026-11-16" },
        { loc: "https://rakazo.com/no-lastmod", lastmod: undefined },
        { loc: "https://example.com/elsewhere", lastmod: "2026-11-16" },
      ],
    });
  });
});

describe("changedSince", () => {
  const { urls } = parseSitemap(urlset);

  it("keeps site pages modified after the timestamp", () => {
    expect(changedSince(urls, new Date("2026-11-15T22:00:00Z"))).toEqual([
      "https://rakazo.com/",
      "https://rakazo.com/search?q=a&b=c",
    ]);
  });

  it("leaves out a page modified exactly at the timestamp", () => {
    expect(changedSince(urls, new Date("2026-11-15T22:41:00Z"))).toEqual([
      "https://rakazo.com/search?q=a&b=c",
    ]);
  });

  it("submits nothing when no page has a lastmod", () => {
    const bare = parseSitemap("<urlset><url><loc>https://rakazo.com/</loc></url></urlset>").urls;
    expect(changedSince(bare, new Date(0))).toEqual([]);
  });
});

describe("indexNowKey", () => {
  it("reads the key from the one key file in public, which holds the key", () => {
    const key = indexNowKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(new URL(`../public/${key}.txt`, import.meta.url), "utf8")).toBe(key);
    expect(indexNowKey(["favicon.ico", "0123456789abcdef0123456789abcdef.txt"])).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });
});
