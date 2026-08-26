export const LOCALES = ["en", "de", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  ko: "한국어",
};

export const LOCALE_OG: Record<Locale, string> = {
  en: "en_US",
  de: "de_DE",
  ko: "ko_KR",
};

export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: "en",
  de: "de",
  ko: "ko",
};

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

export function localeHomePath(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "/" : `/${locale}/`;
}

export function localeHashPath(locale: Locale, hash: string): string {
  const base = localeHomePath(locale);
  const id = hash.replace(/^#/, "");
  return base === "/" ? `/#${id}` : `${base}#${id}`;
}
