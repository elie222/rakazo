import { describe, expect, it } from "vitest";
import type { SpeechLocale } from "./speech-locale.js";
import { recognitionLocaleTag, speechLocaleTag, supportedSpeechTag } from "./speech-locale.js";

const WEB: SpeechLocale[] = ["en", "de", "es", "fr", "nl", "pt-BR", "ru", "zh-CN", "zh-TW"];
const WITHOUT_SPANISH: SpeechLocale[] = ["en", "de", "ru"];

describe("speechLocaleTag", () => {
  it("maps an app locale to a tag the recognizer accepts", () => {
    expect(speechLocaleTag("es")).toBe("es-ES");
    expect(speechLocaleTag("pt-BR")).toBe("pt-BR");
    expect(speechLocaleTag("nl")).toBe("nl-NL");
    expect(speechLocaleTag("ja")).toBe("ja-JP");
    expect(speechLocaleTag("zh-TW")).toBe("zh-TW");
  });
});

describe("recognitionLocaleTag", () => {
  it.each([
    ["es-CL", "es-CL"],
    ["es-MX", "es-MX"],
    ["es_AR", "es-AR"],
    ["es-us", "es-US"],
    ["es-419", "es-MX"],
    ["es", "es-ES"],
    ["es-ES", "es-ES"],
  ])("hears a Spanish speaker on %j as %j", (speaker, tag) => {
    expect(recognitionLocaleTag("es", speaker, WEB)).toBe(tag);
  });

  it("keeps the app's language when the speaker's is another one", () => {
    expect(recognitionLocaleTag("es", "en-US", WEB)).toBe("es-ES");
    expect(recognitionLocaleTag("nl", "de-DE", WEB)).toBe("nl-NL");
    expect(recognitionLocaleTag("es", undefined, WEB)).toBe("es-ES");
    expect(recognitionLocaleTag("es", " ", WEB)).toBe("es-ES");
  });

  it("keeps the speaker's country for other languages too", () => {
    expect(recognitionLocaleTag("pt-BR", "pt-PT", WEB)).toBe("pt-PT");
    expect(recognitionLocaleTag("nl", "nl-BE", WEB)).toBe("nl-BE");
    expect(recognitionLocaleTag("en", "en-US-u-mu-celsius", WEB)).toBe("en-US");
    expect(recognitionLocaleTag("en", "EN-gb", WEB)).toBe("en-GB");
  });

  it("keeps the app's Chinese script over the speaker's region", () => {
    expect(recognitionLocaleTag("zh-TW", "zh-HK", WEB)).toBe("zh-TW");
    expect(recognitionLocaleTag("zh-CN", "zh-Hans-SG", WEB)).toBe("zh-CN");
  });

  it("follows a speaker the English app only falls back for", () => {
    expect(recognitionLocaleTag("en", "it-IT", WEB)).toBe("it-IT");
    expect(recognitionLocaleTag("en", "es-CL", WITHOUT_SPANISH)).toBe("es-CL");
    expect(recognitionLocaleTag("en", "es-419", WITHOUT_SPANISH)).toBe("es-MX");
    expect(recognitionLocaleTag("en", null, WEB)).toBe("en-US");
  });

  it("keeps English for a speaker who picked it over a language the app has", () => {
    expect(recognitionLocaleTag("en", "ru-RU", WEB)).toBe("en-US");
    expect(recognitionLocaleTag("en", "es-CL", WEB)).toBe("en-US");
  });
});

describe("supportedSpeechTag", () => {
  const apple = ["en-AE", "en-GB", "en-US", "es-419", "es-CL", "es-ES", "es-MX", "de-DE"];

  it("keeps a tag the recognizer lists", () => {
    expect(supportedSpeechTag("es-CL", apple)).toBe("es-CL");
    expect(supportedSpeechTag("en_GB", apple)).toBe("en-GB");
  });

  it("falls back to the app's region for the language, then to any region of it", () => {
    expect(supportedSpeechTag("es-AR", apple)).toBe("es-MX");
    expect(supportedSpeechTag("en-DE", apple)).toBe("en-US");
    expect(supportedSpeechTag("de-CH", apple)).toBe("de-DE");
    expect(supportedSpeechTag("es-PE", ["es-419", "es-ES"])).toBe("es-419");
  });

  it("keeps the tag when the recognizer lists nothing or nothing of its language", () => {
    expect(supportedSpeechTag("es-AR", [])).toBe("es-AR");
    expect(supportedSpeechTag("it-IT", apple)).toBe("it-IT");
  });
});
