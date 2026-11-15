import type { SitemapItem } from "@astrojs/sitemap";
import { LOCALE_HREFLANG } from "./i18n/locales";
import { pageDate } from "./page-dates";

/** Dates a sitemap entry from `page-dates`, and points `x-default` at its English version. */
export function sitemapEntry(item: SitemapItem): SitemapItem {
  const lastmod = pageDate(new URL(item.url).pathname);
  const english = item.links?.find((link) => link.lang === LOCALE_HREFLANG.en);
  return {
    ...item,
    ...(lastmod ? { lastmod } : {}),
    ...(item.links && english
      ? { links: [...item.links, { lang: "x-default", url: english.url }] }
      : {}),
  };
}
