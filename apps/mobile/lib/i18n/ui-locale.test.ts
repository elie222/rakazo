import { describe, expect, it } from "vitest";
import { htmlLangForLocale, normalizeUiLocale, resolveUiLocale } from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("ru-RU")).toBe("ru");
    expect(normalizeUiLocale("ru_KZ")).toBe("ru");
    expect(normalizeUiLocale("de")).toBe("de");
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("de-CH")).toBe("de");
    expect(normalizeUiLocale("de_AT")).toBe("de");
    expect(normalizeUiLocale("nl")).toBe("nl");
    expect(normalizeUiLocale("nl-NL")).toBe("nl");
    expect(normalizeUiLocale("nl-BE")).toBe("nl");
    expect(normalizeUiLocale("ja")).toBe("ja");
    expect(normalizeUiLocale("ja-JP")).toBe("ja");
    expect(normalizeUiLocale("es")).toBe("es");
    expect(normalizeUiLocale("es-ES")).toBe("es");
    expect(normalizeUiLocale("es-MX")).toBe("es");
    expect(normalizeUiLocale("es-419")).toBe("es");
    expect(normalizeUiLocale("es_CL")).toBe("es");
    expect(normalizeUiLocale("pl")).toBe("pl");
    expect(normalizeUiLocale("pl-PL")).toBe("pl");
    expect(normalizeUiLocale(" PL_pl ")).toBe("pl");
  });

  it.each([
    "zh-TW",
    "zh_TW",
    " ZH-tw ",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-TW-u-nu-hanidec",
    "zh-Hant-CN",
  ])("maps %s to Traditional Chinese", (tag) => expect(normalizeUiLocale(tag)).toBe("zh-TW"));

  it("honors an explicit Simplified script in Traditional Chinese regions", () => {
    expect(normalizeUiLocale("zh-Hans-TW")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeUiLocale("en-TW")).toBe("en");
    expect(normalizeUiLocale("de-HK")).toBe("de");
  });

  it("matches every language the app ships, regional tags included", () => {
    expect(normalizeUiLocale("fr-FR")).toBe("fr");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("tr")).toBe("tr");
    expect(normalizeUiLocale("hi-IN")).toBe("hi");
    expect(normalizeUiLocale("he-IL")).toBe("he");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("sv-SE")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("htmlLangForLocale", () => {
  it("keeps Simplified Chinese on zh-CN", () => {
    expect(htmlLangForLocale("zh-CN")).toBe("zh-CN");
    expect(htmlLangForLocale("en")).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and device language", () => {
    expect(
      resolveUiLocale({
        stored: "zh-CN",
        envDefault: "zh-CN",
        deviceLanguage: "en-US",
      }),
    ).toBe("zh-CN");
  });

  it("uses the env default, then device language, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "zh-CN",
        deviceLanguage: "en-US",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        deviceLanguage: "zh-CN",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        deviceLanguage: null,
      }),
    ).toBe("en");
  });
});

describe("Traditional Chinese preferences", () => {
  it("uses the device locale and lets a saved choice override it", () => {
    expect(resolveUiLocale({ stored: null, envDefault: null, deviceLanguage: "zh-TW" })).toBe(
      "zh-TW",
    );
    expect(resolveUiLocale({ stored: "zh-TW", envDefault: "en", deviceLanguage: "zh-CN" })).toBe(
      "zh-TW",
    );
    expect(resolveUiLocale({ stored: "zh-CN", envDefault: "zh-TW", deviceLanguage: "zh-TW" })).toBe(
      "zh-CN",
    );
    expect(resolveUiLocale({ stored: null, envDefault: "zh-TW", deviceLanguage: "en" })).toBe(
      "zh-TW",
    );
  });
});

describe("Polish preferences", () => {
  it("detects Polish on the device and honors saved and environment choices", () => {
    expect(resolveUiLocale({ deviceLanguage: "pl-PL" })).toBe("pl");
    expect(resolveUiLocale({ envDefault: "pl", deviceLanguage: "en-US" })).toBe("pl");
    expect(resolveUiLocale({ stored: "pl", envDefault: "en", deviceLanguage: "en-US" })).toBe("pl");
    expect(resolveUiLocale({ stored: "en", deviceLanguage: "pl-PL" })).toBe("en");
    expect(htmlLangForLocale("pl")).toBe("pl");
  });
});
