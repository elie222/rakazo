import { matchUiLocale, translate } from "@rakazo/core";
import type { IpcMainInvokeEvent } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";
import { ES_MESSAGES } from "./locales/es.js";

/** The languages the desktop shell ships; any other language the app offers shows English. */
const DESKTOP_LOCALES = ["en", "es"] as const;
export type DesktopLocale = (typeof DESKTOP_LOCALES)[number];
const CATALOGS: Partial<Record<DesktopLocale, Readonly<Record<string, string>>>> = {
  es: ES_MESSAGES,
};
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

let activeLocale: DesktopLocale = "en";
let reportedLocale: string | null = null;
let saving: Promise<void> = Promise.resolve();

export function t(message: string, values?: Record<string, string | number>): string {
  return translate(CATALOGS[activeLocale], message, values);
}

export function desktopLocale(): DesktopLocale {
  return activeLocale;
}

/** The active translations, keyed by the English text; empty for English. */
export function desktopMessages(): Readonly<Record<string, string>> {
  return CATALOGS[activeLocale] ?? {};
}

/** An error whose message stays English for error reports and shows `detail` to the person. */
export function withDetail<E extends Error>(error: E, detail: string): E & { detail: string } {
  return Object.assign(error, { detail });
}

/** The translated text an error carries for the person, if it was given one. */
export function errorDetail(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : undefined;
}

/** Language tags only, such as `es` or `zh-TW`: pages and saved files supply these. */
export function isLanguageTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= 35 && LANGUAGE_TAG.test(value);
}

/** The language chosen in the app beats the system's; one the desktop has no catalog for is English. */
export function resolveDesktopLocale(
  reported: string | null,
  systemLanguage: string | undefined,
): DesktopLocale {
  return matchUiLocale(reported ?? systemLanguage, DESKTOP_LOCALES);
}

/** Before any server page loads: the last language the app reported, else the system's. */
export function startDesktopLocale(
  saved: string | null,
  systemLanguage: string | undefined,
): DesktopLocale {
  reportedLocale = isLanguageTag(saved) ? saved : null;
  activeLocale = resolveDesktopLocale(reportedLocale, systemLanguage);
  return activeLocale;
}

/**
 * `desktop.locale.set`: the app window's own page reports the language the person chose there.
 * It is saved for the next launch, and `onChange` runs when the desktop's language changes with it.
 */
export function createLocaleHandler(
  getTarget: () => AppTarget | null,
  save: (locale: string) => Promise<void>,
  onChange: () => void,
) {
  return (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    locale: unknown,
  ): Promise<void> => {
    if (!fromAppFrame(getTarget(), event) || !isLanguageTag(locale)) return Promise.resolve();
    if (locale === reportedLocale) return saving;
    reportedLocale = locale;
    const next = resolveDesktopLocale(locale, undefined);
    if (next !== activeLocale) {
      activeLocale = next;
      onChange();
    }
    // One write at a time, skipping any a later report replaced, so a relaunch reads the last.
    saving = saving
      .then(() => (locale === reportedLocale ? save(locale) : undefined))
      .catch(() => {
        // Forget a report that failed to save, so the next one with the same language retries.
        if (reportedLocale === locale) reportedLocale = null;
      });
    return saving;
  };
}
