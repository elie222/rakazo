import { describe, expect, it } from "vitest";
import {
  htmlLangForLocale,
  isUiLocale,
  normalizeUiLocale,
  resolveUiLocale,
  UI_LOCALE_LABELS,
  UI_LOCALES,
} from "./ui-locale";

describe("UI_LOCALES", () => {
  it("only offers locales that have mobile catalogs today", () => {
    expect([...UI_LOCALES]).toEqual(["en", "zh-CN"]);
    expect(Object.keys(UI_LOCALE_LABELS).sort()).toEqual(["en", "zh-CN"]);
    expect(isUiLocale("de")).toBe(false);
    expect(isUiLocale("ko")).toBe(false);
    expect(isUiLocale("tr")).toBe(false);
    expect(isUiLocale("hi")).toBe(false);
    expect(isUiLocale("pt-BR")).toBe(false);
  });
});

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
  });

  it("does not fold Traditional Chinese into Simplified", () => {
    expect(normalizeUiLocale("zh-TW")).toBe("en");
    expect(normalizeUiLocale("zh-HK")).toBe("en");
    expect(normalizeUiLocale("zh-Hant")).toBe("en");
  });

  it("falls back to English for unknown locales and web-only languages", () => {
    expect(normalizeUiLocale("fr-FR")).toBe("en");
    expect(normalizeUiLocale("de")).toBe("en");
    expect(normalizeUiLocale("de-DE")).toBe("en");
    expect(normalizeUiLocale("ko")).toBe("en");
    expect(normalizeUiLocale("ko-KR")).toBe("en");
    expect(normalizeUiLocale("tr")).toBe("en");
    expect(normalizeUiLocale("hi")).toBe("en");
    expect(normalizeUiLocale("pt")).toBe("en");
    expect(normalizeUiLocale("pt-BR")).toBe("en");
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
