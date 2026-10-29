import { describe, expect, it } from "vitest";
import { speechLocaleTag } from "./speech-locale.js";

describe("speechLocaleTag", () => {
  it("maps an app locale to a tag the recognizer accepts", () => {
    expect(speechLocaleTag("es")).toBe("es-ES");
    expect(speechLocaleTag("pt-BR")).toBe("pt-BR");
    expect(speechLocaleTag("nl")).toBe("nl-NL");
    expect(speechLocaleTag("ja")).toBe("ja-JP");
    expect(speechLocaleTag("zh-TW")).toBe("zh-TW");
  });
});
