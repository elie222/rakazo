import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as de } from "@rakazo/i18n/locales/de/messages.po";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { messages as es } from "@rakazo/i18n/locales/es/messages.po";
import { messages as ja } from "@rakazo/i18n/locales/ja/messages.po";
import { messages as nl } from "@rakazo/i18n/locales/nl/messages.po";
import { messages as pl } from "@rakazo/i18n/locales/pl/messages.po";
import { messages as ru } from "@rakazo/i18n/locales/ru/messages.po";
import { messages as zhCN } from "@rakazo/i18n/locales/zh-CN/messages.po";
import { messages as zhTW } from "@rakazo/i18n/locales/zh-TW/messages.po";
import { useSyncExternalStore } from "react";
import { installPluralRules } from "./plural-rules";
import type { UiLocale } from "./ui-locale";
import { htmlLangForLocale, resolveUiLocale, UI_LOCALE_STORAGE_KEY } from "./ui-locale";

const catalogs: Record<UiLocale, Messages> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ru,
  de,
  nl,
  ja,
  es,
  pl,
};

installPluralRules();
i18n.load(catalogs);
i18n.activate("en");

let activeLocale: UiLocale = "en";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveUiLocale(): UiLocale {
  return activeLocale;
}

export function dateLocaleForUi(locale: UiLocale = activeLocale): string {
  return locale === "en" ? "en-US" : htmlLangForLocale(locale);
}

/** The app language, re-rendering when it changes. Strings come from Lingui's `useLingui`. */
export function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribeI18n, getActiveUiLocale, getActiveUiLocale);
}

export function activateUiLocale(locale: UiLocale): UiLocale {
  activeLocale = locale;
  i18n.activate(locale);
  emit();
  return locale;
}

async function applyDirection(locale: UiLocale): Promise<void> {
  try {
    // Direction follows the active UI locale only (all supported locales are LTR), never the
    // device language. Applying device RTL here would fight this and reload-loop.
    const { applyMobileUiDirection } = await import("./ui-direction");
    applyMobileUiDirection(htmlLangForLocale(locale));
  } catch {
    // Tests and some hosts have no native direction APIs.
  }
}

/** The device's preferred language (`es-CL`), from Expo where it loads, else from Intl. */
export async function deviceLanguage(): Promise<string | null> {
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const localization = await import("expo-localization");
    const tag = localization.getLocales()[0]?.languageTag;
    if (typeof tag === "string" && tag) return tag;
  } catch {
    // Keep Intl fallback.
  }
  try {
    const IntlRef = globalThis.Intl;
    return IntlRef?.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

export async function bootstrapI18n(): Promise<UiLocale> {
  let stored: string | null = null;
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const SecureStore = await import("expo-secure-store");
    stored = await SecureStore.getItemAsync(UI_LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const envDefault =
    typeof process !== "undefined" && typeof process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE === "string"
      ? process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE
      : null;
  const locale = resolveUiLocale({ stored, envDefault, deviceLanguage: await deviceLanguage() });
  activateUiLocale(locale);
  await applyDirection(locale);
  return locale;
}

export async function persistUiLocale(locale: UiLocale): Promise<void> {
  try {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore SecureStore failures; in-memory locale still applies.
  }
}

/** Serialize SecureStore writes so rapid picker taps apply in order (last wins). */
let uiLocaleWriteChain: Promise<void> = Promise.resolve();

export async function setUiLocale(locale: UiLocale): Promise<UiLocale> {
  const write = uiLocaleWriteChain.then(async () => {
    await persistUiLocale(locale);
    activateUiLocale(locale);
    await applyDirection(locale);
    return locale;
  });
  uiLocaleWriteChain = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

/** Test-only: set the in-memory locale without I/O. */
export function resetI18nForTests(locale: UiLocale = "en"): void {
  activeLocale = locale;
  i18n.activate(locale);
  uiLocaleWriteChain = Promise.resolve();
  emit();
}
