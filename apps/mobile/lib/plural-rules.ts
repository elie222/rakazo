import { polishPluralCategory } from "@rakazo/core";

/** The plural category of a whole number, for the languages mobile ships. */
export function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  const language = locale.split("-")[0];
  if (language === "zh" || language === "ja") return "other";
  if (language === "pl") return polishPluralCategory(count);
  if (language === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "one";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
    return "many";
  }
  return count === 1 ? "one" : "other";
}

/**
 * Hermes ships without Intl.PluralRules, which Lingui uses to pick a plural form. Only cardinal
 * whole-number rules are filled in; any other count reads as "other".
 */
export function installPluralRules(): void {
  if (typeof Intl.PluralRules === "function") return;
  class PluralRules {
    readonly #locale: string;
    readonly #ordinal: boolean;
    constructor(locales?: string | readonly string[], options?: { type?: string }) {
      this.#locale = (Array.isArray(locales) ? locales[0] : locales) ?? "en";
      this.#ordinal = options?.type === "ordinal";
    }
    select(count: number): Intl.LDMLPluralRule {
      if (this.#ordinal || !Number.isInteger(count)) return "other";
      return pluralCategory(this.#locale, Math.abs(count));
    }
  }
  (Intl as { PluralRules: unknown }).PluralRules = PluralRules;
}
