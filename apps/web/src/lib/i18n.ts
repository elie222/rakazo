import { i18n } from "@lingui/core";
import { applyUiDirection } from "./apply-ui-direction";
import { persistUiLocale, resolveUiLocale, type UiLocale } from "./ui-locale";

export { i18n };

type CatalogMessages = Parameters<typeof i18n.load>[1];
type CatalogModule = { messages: CatalogMessages };
type CatalogLoader = () => Promise<CatalogModule>;

const defaultCatalogLoaders: Record<UiLocale, CatalogLoader> = {
  en: () => import("../locales/en/messages.po") as Promise<CatalogModule>,
  de: () => import("../locales/de/messages.po") as Promise<CatalogModule>,
  ko: () => import("../locales/ko/messages.po") as Promise<CatalogModule>,
};

let catalogLoaders: Record<UiLocale, CatalogLoader> = defaultCatalogLoaders;
let activeLocale: UiLocale | null = null;
let activationGeneration = 0;

/** Test-only: replace catalog loaders (restore with `null`). */
export function setCatalogLoadersForTests(loaders: Record<UiLocale, CatalogLoader> | null): void {
  catalogLoaders = loaders ?? defaultCatalogLoaders;
  activeLocale = null;
  activationGeneration = 0;
}

export function getActiveUiLocale(): UiLocale {
  return activeLocale ?? resolveUiLocale();
}

async function loadCatalog(locale: UiLocale): Promise<CatalogMessages> {
  const { messages } = await catalogLoaders[locale]();
  return messages;
}

function activateLoaded(locale: UiLocale, messages: CatalogMessages): UiLocale {
  i18n.load(locale, messages);
  i18n.activate(locale);
  activeLocale = locale;
  applyUiDirection(locale);
  return locale;
}

/**
 * Load and activate a locale. Concurrent calls: only the latest selection wins.
 * If the preferred catalog fails, falls back to English (then empty English).
 */
export async function activateUiLocale(locale: UiLocale): Promise<UiLocale> {
  if (activeLocale === locale && i18n.locale === locale) return locale;

  const generation = ++activationGeneration;
  const isCurrent = () => generation === activationGeneration;

  try {
    const messages = await loadCatalog(locale);
    if (!isCurrent()) return getActiveUiLocale();
    return activateLoaded(locale, messages);
  } catch {
    if (!isCurrent()) return getActiveUiLocale();
    if (locale !== "en") {
      try {
        const messages = await loadCatalog("en");
        if (!isCurrent()) return getActiveUiLocale();
        return activateLoaded("en", messages);
      } catch {
        // Continue to empty English below.
      }
    }
    if (!isCurrent()) return getActiveUiLocale();
    return activateLoaded("en", {});
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
