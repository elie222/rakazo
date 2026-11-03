export const LOCALES = [
  "en",
  "de",
  "ko",
  "zh",
  "ja",
  "es",
  "fr",
  "pt-br",
  "nl",
  "ru",
  "tr",
  "he",
  "hi",
  "zh-tw",
] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["he"]);

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  ko: "한국어",
  zh: "简体中文",
  ja: "日本語",
  es: "Español",
  fr: "Français",
  "pt-br": "Português (Brasil)",
  nl: "Nederlands",
  ru: "Русский",
  tr: "Türkçe",
  he: "עברית",
  hi: "हिन्दी",
  "zh-tw": "繁體中文",
};

export const LOCALE_OG: Record<Locale, string> = {
  en: "en_US",
  de: "de_DE",
  ko: "ko_KR",
  zh: "zh_CN",
  ja: "ja_JP",
  es: "es_ES",
  fr: "fr_FR",
  "pt-br": "pt_BR",
  nl: "nl_NL",
  ru: "ru_RU",
  tr: "tr_TR",
  he: "he_IL",
  hi: "hi_IN",
  "zh-tw": "zh_TW",
};

export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: "en",
  de: "de",
  ko: "ko",
  zh: "zh-CN",
  ja: "ja",
  es: "es",
  fr: "fr",
  "pt-br": "pt-BR",
  nl: "nl",
  ru: "ru",
  tr: "tr",
  he: "he",
  hi: "hi",
  "zh-tw": "zh-TW",
};

/** BCP 47 tags shared by page hreflang links and the sitemap. */
export const LOCALE_HREFLANG: Record<Locale, string> = {
  en: "en-US",
  de: "de-DE",
  ko: "ko-KR",
  zh: "zh-CN",
  ja: "ja-JP",
  es: "es",
  fr: "fr",
  "pt-br": "pt-BR",
  nl: "nl",
  ru: "ru",
  tr: "tr",
  he: "he",
  hi: "hi",
  "zh-tw": "zh-TW",
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
