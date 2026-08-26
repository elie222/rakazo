export function selectUiLocale(
  deploymentLocale: string | null | undefined,
  savedLocale: string | null | undefined,
  browserLocale: string | null | undefined,
): string {
  return savedLocale?.trim() || deploymentLocale?.trim() || browserLocale?.trim() || "en";
}

export function resolveUiLocale(): string {
  let savedLocale: string | null = null;
  try {
    savedLocale =
      typeof localStorage === "undefined" ? null : localStorage.getItem("rakazo.uiLocale");
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  const browserLocale = typeof navigator === "undefined" ? null : navigator.language;
  const deploymentLocale =
    globalThis.__RAKAZO_RUNTIME_CONFIG__?.defaultUiLocale ?? import.meta.env.VITE_DEFAULT_UI_LOCALE;
  return selectUiLocale(deploymentLocale, savedLocale, browserLocale);
}
