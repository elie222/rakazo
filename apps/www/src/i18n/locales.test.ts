import { describe, expect, it } from "vitest";
import { LOCALE_HREFLANG, LOCALES } from "./locales";

describe("locale hreflang", () => {
  it("uses one regional code per locale for head links and the sitemap", () => {
    expect(LOCALES.map((locale) => LOCALE_HREFLANG[locale])).toEqual([
      "en-US",
      "de-DE",
      "ko-KR",
      "zh-CN",
    ]);
  });
});
