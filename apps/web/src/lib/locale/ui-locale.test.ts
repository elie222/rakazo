import { afterEach, describe, expect, it } from "vitest";
import { persistUiLocale, resolveUiLocale, UI_LOCALE_STORAGE_KEY } from "./ui-locale";

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

  it("uses the environment setting ahead of the browser language", () => {
    expect(
      resolveUiLocale({
        stored: null,
        env: { VITE_DEFAULT_UI_LOCALE: " pl-PL " },
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("pl");
  });

  it("uses the browser language when available and English otherwise", () => {
    const stored = null;
    const envDefault = null;
    expect(
      resolveUiLocale({ stored, envDefault, navigator: { language: "zh-Hant-HK", languages: [] } }),
    ).toBe("zh-TW");
    expect(resolveUiLocale({ stored, envDefault, navigatorLanguage: null })).toBe("en");
  });

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "de" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("de");
  });
});

describe("blocked storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("falls back to the browser language and skips saving when reading storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    expect(resolveUiLocale({ envDefault: null, navigatorLanguage: "de-DE" })).toBe("de");
    expect(() => persistUiLocale("de")).not.toThrow();
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
