import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VOICE_JSON_BYTES,
  readVoiceJson,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceDeadline,
} from "./voice-http.js";

describe("voiceDeadline", () => {
  it("aborts when the client signal aborts", () => {
    const client = new AbortController();
    const combined = voiceDeadline(client.signal, 20_000);
    expect(combined.aborted).toBe(false);
    client.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the deadline elapses even if the client stays connected", async () => {
    const combined = voiceDeadline(new AbortController().signal, 1);
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("deadline did not abort")), 1_000);
      combined.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          resolve();
        },
        { once: true },
      );
    });
    expect(combined.aborted).toBe(true);
  });
});

describe("speechUploadName", () => {
  it("keeps webm recordings as webm even when they name an opus codec", () => {
    expect(speechUploadName("audio/webm;codecs=opus")).toBe("speech.webm");
  });

  it("maps Firefox ogg capture to an ogg filename", () => {
    expect(speechUploadName("audio/ogg; codecs=opus")).toBe("speech.ogg");
  });
});

describe("verifyVoiceHttpGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when the provider accepts the key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: { authorization: "Bearer key" },
        signal: new AbortController().signal,
        provider: "Example",
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBeUndefined();
    expect(init.headers).toEqual({ authorization: "Bearer key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the key-rejected message without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "ElevenLabs",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "ElevenLabs rejected that key. Check the key and that it has speech permissions.",
    });
  });

  it("includes the provider detail when checking the key fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: "voice quota" }), { status: 500 }),
        ),
    );

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "OpenAI",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "checking that key failed: voice quota",
    });
  });

  it("returns the unreachable message when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "Cartesia",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Couldn't reach Cartesia to check that key. Check your connection.",
    });
  });
});

describe("readVoiceJson", () => {
  it("rejects an oversized provider response without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(MAX_VOICE_JSON_BYTES + 1) },
    });

    await expect(readVoiceJson(response)).rejects.toThrow("Voice response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed successful JSON when the caller requires a payload", async () => {
    await expect(readVoiceJson(new Response("not json"), { requireValid: true })).rejects.toThrow(
      "Voice provider returned invalid JSON.",
    );
  });

  it("keeps malformed error bodies optional", async () => {
    await expect(readVoiceJson(new Response("not json"))).resolves.toBeNull();
  });
});
