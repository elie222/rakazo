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

export type SpeechLocale = keyof typeof SPEECH_LOCALE_TAGS;

export function speechLocaleTag(locale: SpeechLocale): string {
  return SPEECH_LOCALE_TAGS[locale];
}
