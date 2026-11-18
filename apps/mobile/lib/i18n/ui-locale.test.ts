import { describe, expect, it } from "vitest";
import { resolveUiLocale } from "./ui-locale";

describe("resolveUiLocale", () => {
  it("prefers the saved choice over the environment and device", () => {
    expect(resolveUiLocale({ stored: "zh-TW", envDefault: "en", deviceLanguage: "zh-CN" })).toBe(
      "zh-TW",
    );
  });

  it("prefers the environment over the device", () => {
    expect(resolveUiLocale({ envDefault: "pl-PL", deviceLanguage: "en-US" })).toBe("pl");
  });

  it("uses the device language when available and English otherwise", () => {
    expect(resolveUiLocale({ deviceLanguage: "zh-Hant-HK" })).toBe("zh-TW");
    expect(resolveUiLocale()).toBe("en");
  });
});
