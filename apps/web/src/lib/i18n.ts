import { i18n } from "@lingui/core";
import { applyUiDirection } from "./apply-ui-direction";
import { persistUiLocale, resolveUiLocale, type UiLocale } from "./ui-locale";

export { i18n };

type CatalogModule = { messages: Record<string, unknown> };

const catalogLoaders: Record<UiLocale, () => Promise<CatalogModule>> = {
  en: () => import("../locales/en/messages.po"),
  de: () => import("../locales/de/messages.po"),
  ko: () => import("../locales/ko/messages.po"),
};

let activeLocale: UiLocale | null = null;
let loading: Promise<UiLocale> | null = null;

export function getActiveUiLocale(): UiLocale {
  return activeLocale ?? resolveUiLocale();
}

export async function activateUiLocale(locale: UiLocale): Promise<UiLocale> {
  if (activeLocale === locale && i18n.locale === locale) return locale;

  const load = async () => {
    const { messages } = await catalogLoaders[locale]();
    i18n.load(locale, messages as Parameters<typeof i18n.load>[1]);
    i18n.activate(locale);
    activeLocale = locale;
    applyUiDirection(locale);
    return locale;
  };

  loading = load();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Resolve preferred locale and load only that catalog. */
export async function bootstrapI18n(preferred: UiLocale = resolveUiLocale()): Promise<UiLocale> {
  return activateUiLocale(preferred);
}

export async function setUiLocale(locale: UiLocale): Promise<UiLocale> {
  persistUiLocale(locale);
  return activateUiLocale(locale);
}
