import { matchUiLocale } from "./ui-locale.js";

/** Speech recognizers need regional BCP-47 tags for the app's UI locale codes. */
const SPEECH_LOCALE_TAGS = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  he: "he-IL",
  hi: "hi-IN",
  ja: "ja-JP",
  ko: "ko-KR",
  nl: "nl-NL",
  "pt-BR": "pt-BR",
  ru: "ru-RU",
  tr: "tr-TR",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
} as const;

/**
 * Recognizers name countries, not Latin America as a whole. Mexico's Spanish is the closest,
 * and every recognizer ships it.
 */
const LATIN_AMERICAN_SPANISH = "es-MX";

export type SpeechLocale = keyof typeof SPEECH_LOCALE_TAGS;

export function speechLocaleTag(locale: SpeechLocale): string {
  return SPEECH_LOCALE_TAGS[locale];
}

/**
 * The language a recognizer listens in, given the app's locale, the speaker's own browser or
 * device language, and the locales this surface ships catalogs for.
 *
 * The speaker's country wins when they speak the app's language (`es-CL`, `en-GB`): a Chilean
 * caller should not be heard as Castilian. English is also the app's fallback for a language
 * it ships no catalog for, so an English app keeps such a speaker's language outright; someone
 * who picked English over a language the app has keeps English. Chinese keeps the app's tag,
 * whose region picks the script.
 */
export function recognitionLocaleTag<L extends SpeechLocale>(
  locale: L,
  speaker: string | null | undefined,
  uiLocales: readonly L[],
): string {
  const appTag = speechLocaleTag(locale);
  const spoken = speakerTag(speaker);
  if (!spoken || locale.startsWith("zh") || matchUiLocale(spoken, uiLocales) !== locale) {
    return appTag;
  }
  const [spokenLanguage, region] = spoken.split("-");
  if (spokenLanguage === appTag.split("-")[0]) {
    return region && /^[A-Z]{2}$/.test(region) ? spoken : appTag;
  }
  return locale === "en" ? spoken : appTag;
}

/** `es_ar`, `en-US-u-mu-celsius`, `zh-Hant-TW` → `es-AR`, `en-US`, `zh-TW`. */
function speakerTag(raw: string | null | undefined): string | null {
  const match = /^([a-z]{2,3})(?:-[a-z]{4})?(?:-([a-z]{2}|\d{3}))?(?:-|$)/i.exec(
    raw?.trim().replace(/_/g, "-") ?? "",
  );
  if (!match?.[1]) return null;
  const language = match[1].toLowerCase();
  const region = match[2]?.toUpperCase();
  if (language === "es" && region === "419") return LATIN_AMERICAN_SPANISH;
  return region ? `${language}-${region}` : language;
}

/**
 * The tag in `supported` closest to `wanted`. iOS starts a recognizer only for a tag it lists
 * exactly, and a phone's language and region (`es-AR`, `en-DE`) often is not one: fall back to
 * the region the app uses for that language, then to any region of it. An empty list means the
 * recognizer does not say, so `wanted` stays.
 */
export function supportedSpeechTag(wanted: string, supported: readonly string[]): string {
  const key = (tag: string) => tag.replace(/_/g, "-").toLowerCase();
  const [language = "", region] = key(wanted).split("-");
  const home =
    language === "es" && region && region !== "es"
      ? LATIN_AMERICAN_SPANISH
      : Object.values(SPEECH_LOCALE_TAGS).find((tag) => key(tag).startsWith(`${language}-`));
  return (
    supported.find((tag) => key(tag) === key(wanted)) ??
    supported.find((tag) => key(tag) === key(home ?? "")) ??
    [...supported].sort().find((tag) => key(tag).split("-")[0] === language) ??
    wanted
  );
}
