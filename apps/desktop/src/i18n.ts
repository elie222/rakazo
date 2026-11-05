import type { TextDirection } from "@rakazo/core";
import { matchUiLocale, textDirectionForLocale, translate } from "@rakazo/core";
import type { IpcMainInvokeEvent } from "electron";
import type { AppTarget } from "./app-frame.js";
import { fromAppFrame } from "./app-frame.js";
import { DE_MESSAGES } from "./locales/de.js";
import { ES_MESSAGES } from "./locales/es.js";
import { FR_MESSAGES } from "./locales/fr.js";
import { HE_MESSAGES } from "./locales/he.js";
import { HI_MESSAGES } from "./locales/hi.js";
import { JA_MESSAGES } from "./locales/ja.js";
import { KO_MESSAGES } from "./locales/ko.js";
import { NL_MESSAGES } from "./locales/nl.js";
import { PL_MESSAGES } from "./locales/pl.js";
import { PT_BR_MESSAGES } from "./locales/pt-BR.js";
import { RU_MESSAGES } from "./locales/ru.js";
import { TR_MESSAGES } from "./locales/tr.js";
import { ZH_CN_MESSAGES } from "./locales/zh-CN.js";
import { ZH_TW_MESSAGES } from "./locales/zh-TW.js";

/** Every language the app offers; English is the source text and needs no catalog. */
export const CATALOGS = {
  de: DE_MESSAGES,
  es: ES_MESSAGES,
  fr: FR_MESSAGES,
  he: HE_MESSAGES,
  hi: HI_MESSAGES,
  ja: JA_MESSAGES,
  ko: KO_MESSAGES,
  nl: NL_MESSAGES,
  pl: PL_MESSAGES,
  "pt-BR": PT_BR_MESSAGES,
  ru: RU_MESSAGES,
  tr: TR_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
  "zh-TW": ZH_TW_MESSAGES,
} as const satisfies Record<string, Readonly<Record<string, string>>>;
export type DesktopLocale = "en" | keyof typeof CATALOGS;
const DESKTOP_LOCALES = ["en", ...Object.keys(CATALOGS)] as DesktopLocale[];
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

let activeLocale: DesktopLocale = "en";
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
export function desktopMessages(): Readonly<Record<string, string>> {
  return activeLocale === "en" ? {} : CATALOGS[activeLocale];
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
  return matchUiLocale(reported ?? systemLanguage, DESKTOP_LOCALES);
}

/** Before any server page loads: the last language the app reported, else the system's. */
export function startDesktopLocale(
  saved: string | null,
  systemLanguage: string | undefined,
): DesktopLocale {
  reportedLocale = isLanguageTag(saved) ? saved : null;
  writtenLocale = reportedLocale;
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
    reportedLocale = locale;
    const next = resolveDesktopLocale(locale, undefined);
    if (next !== activeLocale) {
      activeLocale = next;
      onChange();
    }
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
