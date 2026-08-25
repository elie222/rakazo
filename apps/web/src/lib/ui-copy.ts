import { koreanAdvancedCopy } from "./ui-copy-ko-advanced";
import { koreanCoreCopy } from "./ui-copy-ko-core";
import { resolveUiLocale } from "./ui-locale";

const koreanCopy = {
  ...koreanCoreCopy,
  ...koreanAdvancedCopy,
} as const;

export type UiCopyKey = keyof typeof koreanCopy;
export type UiLanguage = "en" | "ko";

type UiCopyOptions = {
  locale?: string;
  values?: Readonly<Record<string, string | number>>;
};

export function resolveUiLanguage(locale = resolveUiLocale()): UiLanguage {
  return locale.toLowerCase().split("-")[0] === "ko" ? "ko" : "en";
}

export function uiCopy(key: UiCopyKey, options: UiCopyOptions = {}): string {
  const template = resolveUiLanguage(options.locale) === "ko" ? koreanCopy[key] : key;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = options.values?.[name];
    return value === undefined ? match : String(value);
  });
}
