import { matchUiLocale } from "@rakazo/core";

export const UI_LOCALES = ["en", "zh-CN", "zh-TW", "ru", "de", "nl", "ja", "es"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ru: "Русский",
  de: "Deutsch",
  nl: "Nederlands",
  ja: "日本語",
  es: "Español",
};

export function htmlLangForLocale(locale: string): string {
  return locale === "zh-CN" ? "zh-CN" : locale;
}

/** Normalize BCP-47 tags to a mobile UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  return matchUiLocale(raw, UI_LOCALES);
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  deviceLanguage?: string | null;
};

/**
 * Order: saved choice → `EXPO_PUBLIC_DEFAULT_UI_LOCALE` → device language → English.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  if (options.stored) return normalizeUiLocale(options.stored);
  if (options.envDefault) return normalizeUiLocale(options.envDefault);
  if (options.deviceLanguage) return normalizeUiLocale(options.deviceLanguage);
  return "en";
}
