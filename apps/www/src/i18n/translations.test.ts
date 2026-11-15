import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES } from "./locales";
import { englishPath, localizedPath, pageVersions, TRANSLATED_PAGES } from "./translations";

const pagesDir = join(import.meta.dirname, "../pages");

function pageFiles(dir: string, prefix = "/"): string[] {
  return readdirSync(join(pagesDir, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return pageFiles(join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!entry.name.endsWith(".astro")) return [];
    const name = entry.name.replace(/\.astro$/, "");
    return [name === "index" ? prefix : `${prefix}${name}/`];
  });
}

describe("pageVersions", () => {
  it("lists every home page, English first, from any of them", () => {
    const expected = LOCALES.map((locale) => ({
      locale,
      path: locale === DEFAULT_LOCALE ? "/" : `/${locale}/`,
    }));
    expect(pageVersions("/")).toEqual(expected);
    expect(pageVersions("/de/")).toEqual(expected);
    expect(pageVersions("/zh-tw")).toEqual(expected);
  });

  it("is empty for a page that exists only in English", () => {
    expect(pageVersions("/pricing/")).toEqual([]);
    expect(pageVersions("/pricing")).toEqual([]);
    expect(pageVersions("/blog/self-host-an-ai-agent/")).toEqual([]);
    expect(pageVersions("/404")).toEqual([]);
  });
});

describe("englishPath and localizedPath", () => {
  it("map a page between its English and localized paths", () => {
    expect(englishPath("/de/pricing/")).toBe("/pricing/");
    expect(englishPath("/pt-br/")).toBe("/");
    expect(englishPath("/pricing")).toBe("/pricing/");
    expect(englishPath("/design/")).toBe("/design/");
    expect(localizedPath("/pricing/", "de")).toBe("/de/pricing/");
    expect(localizedPath("/pricing/", DEFAULT_LOCALE)).toBe("/pricing/");
  });
});

describe("TRANSLATED_PAGES", () => {
  it("has a page for every registered translation", () => {
    for (const [path, locales] of Object.entries(TRANSLATED_PAGES)) {
      for (const locale of locales) {
        const base = join(pagesDir, locale, path);
        const file = path === "/" ? join(base, "index.astro") : `${base.replace(/\/$/, "")}.astro`;
        expect(
          existsSync(file) || existsSync(join(base, "index.astro")),
          `${localizedPath(path, locale)} is registered but has no page`,
        ).toBe(true);
      }
    }
  });

  it("registers every localized page", () => {
    for (const locale of LOCALES.filter((l) => l !== DEFAULT_LOCALE)) {
      for (const path of pageFiles(locale)) {
        expect(TRANSLATED_PAGES[path] ?? [], `/${locale}${path} is not registered`).toContain(
          locale,
        );
      }
    }
  });
});
