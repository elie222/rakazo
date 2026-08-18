import { describe, expect, it } from "vitest";
import { toVoiceStatus } from "./voice.js";

describe("toVoiceStatus", () => {
  it("treats a saved key without a voice as configured but not ready", () => {
    expect(toVoiceStatus({ provider: "elevenlabs", voiceId: "" })).toEqual({
      configured: true,
      ready: false,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "",
    });
  });

  it("is ready once a voice is chosen", () => {
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).ready).toBe(true);
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).transcribe).toBe(false);
  });

  it("is off when nothing is connected", () => {
    expect(toVoiceStatus(null)).toEqual({
      configured: false,
      ready: false,
      transcribe: false,
      provider: null,
      voiceId: "",
    });
  });
});
