export const UI_LOCALES = ["en", "zh-CN", "ru"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** Locales offered on the mobile Account language picker. */
export const ACCOUNT_UI_LOCALES = ["en", "zh-CN"] as const satisfies readonly UiLocale[];

export type AccountUiLocale = (typeof ACCOUNT_UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ru: "Русский",
};

/** Convert an internal locale identifier to the document language tag. */
export function htmlLangForLocale(locale: string): string {
  return locale === "zh-CN" ? "zh-CN" : locale;
}

/** Return whether a value is one of the supported mobile UI locales. */
export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return value === "en" || value === "zh-CN" || value === "ru";
}

/** Normalize BCP-47 tags to a mobile UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  if (!raw) return "en";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  // Simplified Chinese only. Do not fold zh-TW / zh-HK / zh-Hant into zh-CN.
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-hans-") ||
    normalized.startsWith("zh-cn-")
  ) {
    return "zh-CN";
  }
  if (normalized === "ru" || normalized.startsWith("ru-")) return "ru";
  const primary = normalized.split("-")[0] ?? "";
  return isUiLocale(primary) ? primary : "en";
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
