import { useSyncExternalStore } from "react";
import { DE_MESSAGES, PEER_MESSAGE_FORMS as DE_PEER_FORMS } from "./locales/de";
import { JA_MESSAGES, PEER_MESSAGE_FORMS as JA_PEER_FORMS } from "./locales/ja";
import { NL_MESSAGES, PEER_MESSAGE_FORMS as NL_PEER_FORMS } from "./locales/nl";
import { RU_MESSAGES, PEER_MESSAGE_FORMS as RU_PEER_FORMS } from "./locales/ru";
import { ZH_MESSAGES, PEER_MESSAGE_FORMS as ZH_PEER_FORMS } from "./locales/zh";
import { ZH_TW_MESSAGES, PEER_MESSAGE_FORMS as ZH_TW_PEER_FORMS } from "./locales/zh-TW";
import type { UiLocale } from "./ui-locale";
import { htmlLangForLocale, resolveUiLocale, UI_LOCALE_STORAGE_KEY } from "./ui-locale";

const catalogs: Partial<Record<UiLocale, Record<string, string>>> = {
  "zh-CN": ZH_MESSAGES,
  "zh-TW": ZH_TW_MESSAGES,
  ru: RU_MESSAGES,
  de: DE_MESSAGES,
  nl: NL_MESSAGES,
  ja: JA_MESSAGES,
};

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

export function t(message: string, values?: Record<string, string | number>): string {
  const template = catalogs[activeLocale]?.[message] ?? message;
  if (!values) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

export function useI18n(): { locale: UiLocale; t: typeof t } {
  const locale = useSyncExternalStore(subscribeI18n, getActiveUiLocale, getActiveUiLocale);
  return { locale, t };
}

function readDeviceLanguage(): string | null {
  try {
    const IntlRef = globalThis.Intl;
    return IntlRef?.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

export function activateUiLocale(locale: UiLocale): UiLocale {
  activeLocale = locale;
  emit();
  return locale;
}

async function applyDirection(locale: UiLocale): Promise<void> {
  try {
    // Direction follows the active UI locale only (en / zh-CN / zh-TW / ru / de / nl / ja → LTR), never the
    // device language. Applying device RTL here would fight this and reload-loop.
    const { applyMobileUiDirection } = await import("./ui-direction");
    applyMobileUiDirection(htmlLangForLocale(locale));
  } catch {
    // Tests and some hosts have no native direction APIs.
  }
}

export async function bootstrapI18n(): Promise<UiLocale> {
  let stored: string | null = null;
  let deviceLanguage: string | null = readDeviceLanguage();
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const SecureStore = await import("expo-secure-store");
    stored = await SecureStore.getItemAsync(UI_LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  try {
    const localization = await import("expo-localization");
    const tag = localization.getLocales()[0]?.languageTag;
    if (typeof tag === "string" && tag) deviceLanguage = tag;
  } catch {
    // Keep Intl fallback.
  }
  const envDefault =
    typeof process !== "undefined" && typeof process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE === "string"
      ? process.env.EXPO_PUBLIC_DEFAULT_UI_LOCALE
      : null;
  const locale = resolveUiLocale({ stored, envDefault, deviceLanguage });
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
  uiLocaleWriteChain = Promise.resolve();
  emit();
}

/** Counted exchanges use the same locale as the rest of the mobile chrome. */
export function peerExchangeLabel(
  count: number,
  direction: "sent" | "received",
  peer: string,
): string {
  if (count === 1)
    return direction === "sent"
      ? t("Messaged {peer}", { peer })
      : t("Message from {peer}", { peer });
  const forms: Partial<Record<UiLocale, Partial<Record<Intl.LDMLPluralRule, string>>>> = {
    ja: JA_PEER_FORMS,
    "zh-TW": ZH_TW_PEER_FORMS,
    de: DE_PEER_FORMS,
    nl: NL_PEER_FORMS,
    ru: RU_PEER_FORMS,
    "zh-CN": ZH_PEER_FORMS,
  };
  // Hermes ships without Intl.PluralRules, so pick the category by hand.
  const category = pluralCategory(activeLocale, count);
  const localized = forms[activeLocale];
  const template = localized?.[category] ?? localized?.other ?? "{count} messages with {peer}";
  return template.replace("{count}", String(count)).replace("{peer}", peer);
}

function pluralCategory(locale: UiLocale, count: number): Intl.LDMLPluralRule {
  if (locale === "zh-CN") return "other";
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "one";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
    return "many";
  }
  return count === 1 ? "one" : "other";
}
