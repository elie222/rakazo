import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  loadVoiceCredential,
  MAX_SPEAK_REQUEST_BYTES,
  MAX_TRANSCRIBE_REQUEST_BYTES,
  mountVoiceHttpRoutes,
  resolveVoiceTarget,
  toVoiceCredential,
  toVoiceStatus,
  type VoiceDeps,
} from "./voice.js";

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

  it.each([
    ["/api/voice/speak", MAX_SPEAK_REQUEST_BYTES],
    ["/api/voice/transcribe", MAX_TRANSCRIBE_REQUEST_BYTES],
  ])(
    "rejects a declared oversized body on %s without waiting for cancellation",
    async (path, max) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const app = new Hono();
      mountVoiceHttpRoutes(
        app,
        {} as VoiceDeps,
        async () => ({ userId: "user", spaceId: "space" }) as Actor,
      );

      const response = await app.request(request);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops reading a streamed oversized speak body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SPEAK_REQUEST_BYTES + 1));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {} as VoiceDeps,
      async () => ({ userId: "user", spaceId: "space" }) as Actor,
    );

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("deployment supplied voice", () => {
  const actor = { userId: "user", spaceId: "space" } as Actor;
  function fixture() {
    const prisma = {
      spaceVoicePreference: { findFirst: vi.fn(async () => null) },
      userVoiceCredential: { findFirst: vi.fn(async () => null) },
      bot: { findFirst: vi.fn(async () => null) },
      secret: { findFirst: vi.fn() },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn() },
      deploymentVoice: {
        provider: "openai",
        apiKey: "test-server-voice-secret",
        voiceId: "coral",
      },
    } as unknown as VoiceDeps;
    return { deps, prisma };
  }
  it("works without a customer credential and never serializes the server key", async () => {
    const { deps, prisma } = fixture();
    const loaded = await loadVoiceCredential(deps, actor);
    expect(loaded?.apiKey).toBe("test-server-voice-secret");
    expect(toVoiceStatus(loaded?.cred ?? null)).toMatchObject({ ready: true, transcribe: true });
    expect(JSON.stringify(toVoiceCredential(loaded!.cred))).not.toContain(
      "test-server-voice-secret",
    );
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });
  it("does not substitute the hosted key for a different voice provider", async () => {
    const { deps } = fixture();
    expect(await loadVoiceCredential(deps, actor, "elevenlabs")).toBeNull();
    expect((await loadVoiceCredential(deps, actor, "openai"))?.cred.voiceId).toBe("coral");
  });
  it("preserves an unconfigured self-hosted installation", async () => {
    const { deps } = fixture();
    delete deps.deploymentVoice;
    expect(await loadVoiceCredential(deps, actor)).toBeNull();
  });
  it("checks bot ownership before granting hosted voice access", async () => {
    const { deps, prisma } = fixture();
    await expect(resolveVoiceTarget(deps, actor, { botId: "foreign-bot" })).rejects.toThrow();
    expect(prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-bot", userId: "user", spaceId: "space" },
      select: { voiceId: true },
    });
    expect(prisma.spaceVoicePreference.findFirst).not.toHaveBeenCalled();
  });
});
