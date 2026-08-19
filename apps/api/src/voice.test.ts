import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountVoiceHttpRoutes, toVoiceStatus, type VoiceDeps } from "./voice.js";

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

describe("voice HTTP routes", () => {
  it("rejects unauthenticated speak and transcribe", async () => {
    const app = new Hono();
    mountVoiceHttpRoutes(app, {} as VoiceDeps, async () => null);
    const speak = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const transcribe = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/webm" }),
    });
    expect(speak.status).toBe(401);
    expect(transcribe.status).toBe(401);
  });
});
