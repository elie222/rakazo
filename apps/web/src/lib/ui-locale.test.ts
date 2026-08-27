import { describe, expect, it } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  UI_LOCALE_STORAGE_KEY,
} from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeUiLocale("pt")).toBe("pt-BR");
    expect(normalizeUiLocale("hi-IN")).toBe("hi");
    expect(normalizeUiLocale("DE")).toBe("de");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("fr-FR")).toBe("en");
    expect(normalizeUiLocale("he-IL")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and navigator", () => {
    expect(
      resolveUiLocale({
        stored: "ko",
        envDefault: "de",
        navigatorLanguage: "en-US",
      }),
    ).toBe("ko");
  });

  it("uses VITE_DEFAULT_UI_LOCALE when nothing is saved", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "de-AT",
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("de");
  });

  it("uses navigator.language next, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("ko");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "fr-FR",
      }),
    ).toBe("en");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: null,
      }),
    ).toBe("en");
  });

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "de" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("de");
  });
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("ko", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
  });
});
