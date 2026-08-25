import { describe, expect, it } from "vitest";
import { resolveUiLanguage, uiCopy } from "./ui-copy";

describe("uiCopy", () => {
  it("uses Korean for Korean locale variants", () => {
    expect(resolveUiLanguage("ko-KR")).toBe("ko");
    expect(resolveUiLanguage("ko")).toBe("ko");
  });

  it("falls back to English for unsupported locales", () => {
    expect(resolveUiLanguage("fr-FR")).toBe("en");
    expect(uiCopy("Search", { locale: "fr-FR" })).toBe("Search");
  });

  it("returns natural Korean copy without translating product names", () => {
    expect(uiCopy("Search", { locale: "ko-KR" })).toBe("검색");
    expect(uiCopy("Connect a model", { locale: "ko-KR" })).toBe("AI 모델 연결");
    expect(uiCopy("New bot", { locale: "ko-KR" })).toBe("새 Bot 만들기");
  });

  it("interpolates dynamic labels", () => {
    expect(
      uiCopy("Message {name}", {
        locale: "ko-KR",
        values: { name: "올리" },
      }),
    ).toBe("올리에게 메시지 보내기");
  });
});
