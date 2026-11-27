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
import { TH_MESSAGES } from "./locales/th.js";
import { TR_MESSAGES } from "./locales/tr.js";
import { ZH_CN_MESSAGES } from "./locales/zh-CN.js";
import { ZH_TW_MESSAGES } from "./locales/zh-TW.js";

/**
 * Every language the app offers except English, which is the source text.
 * Vitest and `tsx` use this map. The desktop build replaces the module with a
 * disk loader so `dist/main.js` does not contain these catalogs.
 */
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
  th: TH_MESSAGES,
  tr: TR_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
  "zh-TW": ZH_TW_MESSAGES,
} as const satisfies Record<string, Readonly<Record<string, string>>>;
