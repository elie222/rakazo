import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "../i18n/ui-locale";

type AppConfig = {
  expo: { locales?: Record<string, string>; ios?: { infoPlist?: Record<string, unknown> } };
};

const mobileRoot = resolve(import.meta.dirname, "..", "..");
const config = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8")) as AppConfig;

/** Apple's folder for a UI language: script subtags for Chinese, the language tag otherwise. */
const APPLE_LOCALES: Record<string, string> = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" };
const translated = UI_LOCALES.filter((locale) => locale !== "en").map(
  (locale) => APPLE_LOCALES[locale] ?? locale,
);

describe("iOS permission prompts", () => {
  it.each(translated)("has a %s version of every prompt the app shows", (locale) => {
    expect(config.expo.locales?.[locale]).toBe(`./locales/${locale}.json`);
    // Under `ios`: Expo writes top-level keys to Android resources too.
    const messages = (
      JSON.parse(readFileSync(resolve(mobileRoot, `locales/${locale}.json`), "utf8")) as {
        ios: Record<string, string>;
      }
    ).ios;
    // Prompts the config plugins add (microphone, speech, Face ID) sit beside the app's own.
    const prompts = [
      ...Object.keys(config.expo.ios?.infoPlist ?? {}).filter((key) =>
        key.endsWith("UsageDescription"),
      ),
      "NSMicrophoneUsageDescription",
      "NSSpeechRecognitionUsageDescription",
      "NSFaceIDUsageDescription",
    ];
    for (const key of prompts) expect(messages[key]?.trim(), key).toBeTruthy();
  });
});
