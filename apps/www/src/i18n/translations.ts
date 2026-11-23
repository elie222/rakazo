import { marketing } from "../marketing-site";
import type { Locale } from "./locales";
import { DEFAULT_LOCALE, isLocale, LOCALES } from "./locales";

/**
 * Pages that exist in more languages than English, keyed by their English path, with the
 * locales each one is translated into. The translation of `/path/` lives at `/{locale}/path/`.
 */
export const TRANSLATED_PAGES: Readonly<Record<string, readonly Locale[]>> = {
  "/": LOCALES.filter((locale) => locale !== DEFAULT_LOCALE),
  ...marketing.translatedPages,
};

export type PageVersion = { locale: Locale; path: string };

function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function localizedPath(englishPath: string, locale: Locale): string {
  return locale === DEFAULT_LOCALE ? englishPath : `/${locale}${englishPath}`;
}

/** The English path of any page, localized or not. */
export function englishPath(pathname: string): string {
  const path = withTrailingSlash(pathname);
  const [, first] = path.split("/");
  return first !== DEFAULT_LOCALE && isLocale(first) ? path.slice(first.length + 1) : path;
}

/**
 * Every language version of the page at `pathname`, itself included, English first.
 * Empty when the page exists only in one language.
 */
export function pageVersions(pathname: string): PageVersion[] {
  const english = englishPath(pathname);
  const translated = TRANSLATED_PAGES[english];
  if (!translated || translated.length === 0) return [];
  return [DEFAULT_LOCALE, ...translated].map((locale) => ({
    locale,
    path: localizedPath(english, locale),
  }));
}

/**
 * Where a site link should go for a reader of `locale`: the translation of `href` when one exists,
 * otherwise `href` unchanged. Keeps any `#hash` or `?query`.
 */
export function localizedHref(href: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE || !href.startsWith("/") || href.startsWith("//")) return href;
  const match = /^([^?#]*)(.*)$/.exec(href);
  const path = match?.[1] ?? href;
  const rest = match?.[2] ?? "";
  const english = englishPath(path);
  return TRANSLATED_PAGES[english]?.includes(locale)
    ? `${localizedPath(english, locale)}${rest}`
    : href;
}
