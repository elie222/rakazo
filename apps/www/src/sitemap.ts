import type { SitemapItem } from "@astrojs/sitemap";
import { LOCALE_HREFLANG } from "./i18n/locales";
import { marketing } from "./marketing-site";

/** Dates a sitemap entry from the date its page shows, and points `x-default` at its English version. */
export function sitemapEntry(item: SitemapItem): SitemapItem {
  const lastmod = marketing.pageDate(new URL(item.url).pathname);
  const english = item.links?.find((link) => link.lang === LOCALE_HREFLANG.en);
  return {
    ...item,
    ...(lastmod ? { lastmod } : {}),
    ...(item.links && english
      ? { links: [...item.links, { lang: "x-default", url: english.url }] }
      : {}),
  };
}
