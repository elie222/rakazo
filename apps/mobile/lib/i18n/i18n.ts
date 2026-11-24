import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as de } from "@rakazo/i18n/locales/de/messages.po";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { messages as es } from "@rakazo/i18n/locales/es/messages.po";
import { messages as fr } from "@rakazo/i18n/locales/fr/messages.po";
import { messages as he } from "@rakazo/i18n/locales/he/messages.po";
import { messages as hi } from "@rakazo/i18n/locales/hi/messages.po";
import { messages as ja } from "@rakazo/i18n/locales/ja/messages.po";
import { messages as ko } from "@rakazo/i18n/locales/ko/messages.po";
import { messages as nl } from "@rakazo/i18n/locales/nl/messages.po";
import { messages as pl } from "@rakazo/i18n/locales/pl/messages.po";
import { messages as ptBR } from "@rakazo/i18n/locales/pt-BR/messages.po";
import { messages as ru } from "@rakazo/i18n/locales/ru/messages.po";
import { messages as th } from "@rakazo/i18n/locales/th/messages.po";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { messages as zhCN } from "@rakazo/i18n/locales/zh-CN/messages.po";
import { messages as zhTW } from "@rakazo/i18n/locales/zh-TW/messages.po";
import { bestEffort } from "@rakazo/logging/best-effort";
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
  fr,
  he,
  hi,
  ko,
  "pt-BR": ptBR,
  tr,
  th,
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

type DeviceDateFormat = { region: string | null; hourCycle: "h12" | "h23" | null };

const NO_DEVICE_DATE_FORMAT: DeviceDateFormat = { region: null, hourCycle: null };
let deviceDateFormat = NO_DEVICE_DATE_FORMAT;

/**
 * The locale dates, times and numbers are formatted in: the app language written the way the
 * phone's region writes it, on the phone's 12- or 24-hour clock (`en-GB-u-hc-h23`).
 */
export function dateLocaleForUi(locale: UiLocale = activeLocale): string {
  const language = htmlLangForLocale(locale);
  const { region, hourCycle } = deviceDateFormat;
  // A language that names its own region (zh-TW, pt-BR) keeps it: there the region picks the wording.
  let base = language;
  if (!language.includes("-")) {
    if (region) base = `${language}-${region}`;
    else if (locale === "en") base = "en-US";
  }
  return hourCycle ? `${base}-u-hc-${hourCycle}` : base;
}

export function useDateLocale(): string {
  return useSyncExternalStore(subscribeI18n, dateLocaleForUi, dateLocaleForUi);
}

export async function refreshDeviceDateFormat(): Promise<void> {
  const format = await bestEffort(
    "read device date format",
    import("expo-localization").then(({ getLocales, getCalendars }): DeviceDateFormat => {
      const region = getLocales()[0]?.regionCode;
      const uses24hourClock = getCalendars()[0]?.uses24hourClock;
      return {
        region: region && /^([A-Z]{2}|\d{3})$/.test(region) ? region : null,
        hourCycle: uses24hourClock === true ? "h23" : uses24hourClock === false ? "h12" : null,
      };
    }),
  );
  if (format) updateDeviceDateFormat(format);
}

function updateDeviceDateFormat(format: DeviceDateFormat): void {
  if (format.region === deviceDateFormat.region && format.hourCycle === deviceDateFormat.hourCycle)
    return;
  deviceDateFormat = format;
  emit();
}

/** Test-only: set the phone's date preferences without native modules. */
export function setDeviceDateFormatForTests(format: Partial<DeviceDateFormat>): void {
  updateDeviceDateFormat({ ...NO_DEVICE_DATE_FORMAT, ...format });
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
  await refreshDeviceDateFormat();
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
  deviceDateFormat = NO_DEVICE_DATE_FORMAT;
  i18n.activate(locale);
  uiLocaleWriteChain = Promise.resolve();
  emit();
}
