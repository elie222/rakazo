import { AppLocaleSchema } from "@rakazo/contracts";
import { matchUiLocale } from "@rakazo/core";

/** The app languages mobile ships catalogs for. */
const SHIPPED_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ru",
  "de",
  "nl",
  "ja",
  "es",
  "pl",
] as const satisfies readonly (typeof AppLocaleSchema.options)[number][];

export type UiLocale = (typeof SHIPPED_LOCALES)[number];

/** Mobile's languages, in the order every app lists them. */
export const UI_LOCALES = AppLocaleSchema.options.filter((locale): locale is UiLocale =>
  (SHIPPED_LOCALES as readonly string[]).includes(locale),
);

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

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
