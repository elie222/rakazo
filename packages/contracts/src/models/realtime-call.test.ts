import { describe, expect, it } from "vitest";
import { parseRealtimeCallSettings, RealtimeCallSettingsSchema } from "./realtime-call.js";

describe("realtime call settings", () => {
  const valid = { provider: "voice-provider", model: "voice-model" };

  it("accepts the standard call and every listed option", () => {
    expect(RealtimeCallSettingsSchema.parse({})).toEqual({ provider: "", model: "" });
    expect(
      RealtimeCallSettingsSchema.parse({
        ...valid,
        speed: 1.25,
        patience: "balanced",
        noiseReduction: "off",
        language: "de",
        thinking: "fast",
        vadThreshold: 0.6,
        silenceMs: 700,
        maxOutputTokens: 600,
      }),
    ).toMatchObject({ speed: 1.25, patience: "balanced", noiseReduction: "off", language: "de" });
  });

  it.each([
    ["a speed below the provider range", { speed: 0.2 }],
    ["a speed above the provider range", { speed: 1.6 }],
    ["an unknown patience", { patience: "normal" }],
    ["an unknown microphone", { noiseReduction: "studio" }],
    ["a language that is not ISO 639-1", { language: "deu" }],
    ["an upper-case language code", { language: "DE" }],
    ["a quiet gap outside 200 to 3000 ms", { silenceMs: 50 }],
  ])("rejects %s", (_name, option) => {
    expect(RealtimeCallSettingsSchema.safeParse({ ...valid, ...option }).success).toBe(false);
  });

  it("reads stored settings that no longer parse as the standard call", () => {
    expect(parseRealtimeCallSettings({ ...valid, patience: "normal" })).toEqual({
      provider: "",
      model: "",
    });
    expect(parseRealtimeCallSettings(null)).toEqual({ provider: "", model: "" });
  });
});
