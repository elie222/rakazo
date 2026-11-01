import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type AppConfig = {
  expo: { locales?: Record<string, string>; ios?: { infoPlist?: Record<string, unknown> } };
};

const mobileRoot = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8")) as AppConfig;

describe("iOS permission prompts", () => {
  it("has a Spanish version of every prompt the app shows", () => {
    expect(config.expo.locales?.es).toBe("./locales/es.json");
    // Under `ios`: Expo writes top-level keys to Android resources too.
    const spanish = (
      JSON.parse(readFileSync(resolve(mobileRoot, "locales/es.json"), "utf8")) as {
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
    for (const key of prompts) expect(spanish[key]?.trim(), key).toBeTruthy();
  });
});
