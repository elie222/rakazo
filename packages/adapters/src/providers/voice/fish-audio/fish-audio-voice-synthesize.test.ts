import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Fish Audio speech", () => {
  it("translates managed tuning without recognizing a private reference id", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([7, 8]), { headers: { "content-type": "audio/mpeg" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await new FishAudioVoiceProvider().synthesize(
      {
        text: "你好。",
        voiceId: "managed-reference",
        apiKey: "test-key",
        model: "s2-pro",
        settings: {
          temperature: 0.55,
          topP: 0.61,
          speed: 0.9,
          volume: -1,
          normalizeLoudness: true,
        },
      },
      context,
    );

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.fish.audio/v1/tts");
    expect(new Headers(init?.headers).get("model")).toBe("s2-pro");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "你好。",
      reference_id: "managed-reference",
      format: "mp3",
      mp3_bitrate: 64,
      latency: "balanced",
      normalize: true,
      temperature: 0.55,
      top_p: 0.61,
      prosody: { speed: 0.9, volume: -1, normalize_loudness: true },
    });
  });

  it.each([{ temperature: 4 }, { unknown: true }])(
    "rejects invalid managed settings before sending a request",
    async (settings) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      await expect(
        new FishAudioVoiceProvider().synthesize(
          {
            text: "Hello.",
            voiceId: "managed-reference",
            apiKey: "test-key",
            settings,
          },
          context,
        ),
      ).rejects.toThrow("voice settings");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
