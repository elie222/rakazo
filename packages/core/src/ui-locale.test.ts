import { describe, expect, it } from "vitest";
import { matchUiLocale } from "./ui-locale.js";

const ALL = ["en", "de", "es", "he", "pt-BR", "ru", "zh-CN", "zh-TW"] as const;
const FEW = ["en", "de", "zh-CN"] as const;

describe("matchUiLocale", () => {
  it("maps regional, underscored, and cased tags onto a supported locale", () => {
    expect(matchUiLocale("de-DE", ALL)).toBe("de");
    expect(matchUiLocale(" RU ", ALL)).toBe("ru");
    expect(matchUiLocale("ru_KZ", ALL)).toBe("ru");
    expect(matchUiLocale("pt", ALL)).toBe("pt-BR");
    expect(matchUiLocale("es-419", ALL)).toBe("es");
    expect(matchUiLocale("iw-IL", ALL)).toBe("he");
    expect(matchUiLocale("zh_Hans_CN", ALL)).toBe("zh-CN");
    expect(matchUiLocale("zh-SG", ALL)).toBe("zh-CN");
  });

  it("keeps Traditional and Simplified Chinese apart, script before region", () => {
    expect(matchUiLocale("zh-TW", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh-Hant-HK", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh_MO", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh-Hans-TW", ALL)).toBe("zh-CN");
    expect(matchUiLocale("zh-TW", FEW)).toBe("en");
  });

  it("falls back to English for locales the surface does not ship", () => {
    expect(matchUiLocale("pt-BR", FEW)).toBe("en");
    expect(matchUiLocale("es-MX", FEW)).toBe("en");
    expect(matchUiLocale("iw", FEW)).toBe("en");
    expect(matchUiLocale("sv-SE", ALL)).toBe("en");
    expect(matchUiLocale("", ALL)).toBe("en");
    expect(matchUiLocale(null, ALL)).toBe("en");
  });
});
