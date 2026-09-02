import { describe, expect, it } from "vitest";
import { htmlLangForLocale, normalizeUiLocale, resolveUiLocale } from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("pt")).toBe("pt-BR");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
  });

  it("does not fold Traditional Chinese into Simplified", () => {
    expect(normalizeUiLocale("zh-TW")).toBe("en");
    expect(normalizeUiLocale("zh-HK")).toBe("en");
    expect(normalizeUiLocale("zh-Hant")).toBe("en");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("fr-FR")).toBe("en");
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
        envDefault: "de",
        deviceLanguage: "en-US",
      }),
    ).toBe("zh-CN");
  });

  it("uses the env default, then device language, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "zh-CN",
        deviceLanguage: "ko-KR",
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
