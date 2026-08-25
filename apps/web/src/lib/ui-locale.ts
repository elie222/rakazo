export function selectUiLocale(
  deploymentLocale: string | null | undefined,
  savedLocale: string | null | undefined,
  browserLocale: string | null | undefined,
): string {
  return deploymentLocale?.trim() || savedLocale?.trim() || browserLocale?.trim() || "en";
}

export function resolveUiLocale(): string {
  const savedLocale =
    typeof localStorage === "undefined" ? null : localStorage.getItem("rakazo.uiLocale");
  const browserLocale = typeof navigator === "undefined" ? null : navigator.language;
  return selectUiLocale(import.meta.env.VITE_DEFAULT_UI_LOCALE, savedLocale, browserLocale);
}
