export const UI_LOCALES = ["en", "zh-CN"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export function htmlLangForLocale(locale: string): string {
  return locale === "zh-CN" ? "zh-CN" : locale;
}

export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return value === "en" || value === "zh-CN";
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
