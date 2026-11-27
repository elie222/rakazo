import type { TextDirection } from "@rakazo/core/text-direction";
import { textDirectionForLocale } from "@rakazo/core/text-direction";
import { translate } from "@rakazo/core/translate";
import { matchUiLocale } from "@rakazo/core/ui-locale";
import type { DesktopCatalogTag, DesktopMessages } from "./locale-catalogs.js";
import { desktopCatalogTags, loadDesktopCatalog } from "./locale-catalogs.js";

export type DesktopLocale = "en" | DesktopCatalogTag;
const ENGLISH_MESSAGES: DesktopMessages = {};
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

let activeLocale: DesktopLocale = "en";
let activeMessages = ENGLISH_MESSAGES;
let reportedLocale: string | null = null;
/** The language last written to disk, so the same one is not written twice. */
let writtenLocale: string | null = null;
let saving: Promise<void> = Promise.resolve();

export function t(message: string, values?: Record<string, string | number>): string {
  return translate(desktopMessages(), message, values);
}

export function desktopLocale(): DesktopLocale {
  return activeLocale;
}

/** The active translations, keyed by the English text; empty for English. */
export function desktopMessages(): DesktopMessages {
  return activeMessages;
}

function activateLocale(locale: DesktopLocale): void {
  const messages = locale === "en" ? ENGLISH_MESSAGES : loadDesktopCatalog(locale);
  activeLocale = messages === undefined ? "en" : locale;
  activeMessages = messages ?? ENGLISH_MESSAGES;
}

export function desktopDirection(): TextDirection {
  return textDirectionForLocale(activeLocale);
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
  return matchUiLocale(reported ?? systemLanguage, desktopCatalogTags);
}

/** Before any server page loads: the last language the app reported, else the system's. */
export function startDesktopLocale(
  saved: string | null,
  systemLanguage: string | undefined,
): DesktopLocale {
  reportedLocale = isLanguageTag(saved) ? saved : null;
  writtenLocale = reportedLocale;
  activateLocale(resolveDesktopLocale(reportedLocale, systemLanguage));
  return activeLocale;
}

/**
 * `desktop.locale.set`: the app window's own page reports the language the person chose there.
 * It is saved for the next launch, and `onChange` runs when the desktop's language changes with it.
 */
export function createLocaleHandler(save: (locale: string) => Promise<void>, onChange: () => void) {
  return (_event: unknown, locale: unknown): Promise<void> => {
    if (!isLanguageTag(locale)) return Promise.resolve();
    reportedLocale = locale;
    const previous = activeLocale;
    activateLocale(resolveDesktopLocale(locale, undefined));
    if (activeLocale !== previous) onChange();
    // One write at a time, and only of the latest report not on disk yet: a relaunch reads the
    // last language reported, and the next report retries a failed write.
    saving = saving
      .then(async () => {
        const wanted = reportedLocale;
        if (wanted === null || wanted === writtenLocale) return;
        await save(wanted);
        writtenLocale = wanted;
      })
      .catch(() => undefined);
    return saving;
  };
}
