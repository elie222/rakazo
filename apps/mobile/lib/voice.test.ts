import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import {
  MAX_VOICE_AUDIO_BYTES,
  playMpeg,
  speakText,
  speakUtterance,
  speakWithDeviceVoice,
  VOICE_RESPONSE_TIMEOUT_MS,
} from "./voice";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-speech", () => ({ speak: vi.fn(), stop: vi.fn() }));
vi.mock("./api", () => ({
  authHeaders: vi.fn(),
  captureApiRequestContext: vi.fn(),
  currentApiBase: vi.fn(() => "https://api.example"),
  rpc: vi.fn(),
}));

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";

  async play() {
    setTimeout(() => this.onended?.(), 0);
  }

  pause() {}
}

describe("mobile speech", () => {
  beforeEach(() => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    vi.mocked(captureApiRequestContext).mockResolvedValue({
      apiBase: "https://support.example",
      headers: {
        authorization: "Bearer support-token",
        "x-rakazo-space-id": "space-support",
      },
    });
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      vi.mocked(currentApiBase).mockReturnValue("https://finance.example");
      return { ready: true, utterances: ["First", "Second"] } as never;
    });
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps every request on the server and space captured before preparation", async () => {
    await expect(speakText("Read this", { botId: "bot-1" })).resolves.toBe(true);

    const requestContext = {
      apiBase: "https://support.example",
      headers: {
        authorization: "Bearer support-token",
        "x-rakazo-space-id": "space-support",
      },
    };
    expect(rpc).toHaveBeenCalledWith(
      "voice/prepare",
      { text: "Read this", voiceId: undefined, botId: "bot-1" },
      { requestContext },
    );
    expect(captureApiRequestContext).toHaveBeenCalledTimes(1);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://support.example/api/voice/speak");
      expect(init?.headers).toMatchObject(requestContext.headers);
    }
  });

  it("listens for an HTML audio clip ending before playback starts", async () => {
    class ImmediateAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;

      async play() {
        expect(this.onended).toBeTypeOf("function");
        this.onended?.();
      }
    }
    vi.stubGlobal("Audio", ImmediateAudio);

    await expect(playMpeg(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });

  it("rejects oversized audio without waiting for response cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_VOICE_AUDIO_BYTES + 1) },
          }),
      ),
    );

    await expect(
      speakUtterance("Hello.", { requestContext: await captureApiRequestContext() }),
    ).rejects.toThrow("Voice response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a voice response body is stalled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => undefined),
            }),
          ),
      ),
    );

    const pending = speakUtterance("Hello.", {
      requestContext: await captureApiRequestContext(),
    });
    const rejected = expect(pending).rejects.toThrow("Voice request timed out.");
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS);

    await rejected;
  });
});

async function flushDeviceSpeechImport() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("on-device speech", () => {
  beforeEach(() => {
    vi.mocked(Speech.speak).mockReset();
    vi.mocked(Speech.stop).mockReset();
    vi.mocked(rpc).mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("on-device speech must not touch the network");
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("speaks locally and never touches the network when the device voice is on", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    vi.mocked(Speech.speak).mockImplementation((_text, options) => options?.onDone?.());

    await expect(speakText("Read this")).resolves.toBe(true);

    expect(Speech.stop).toHaveBeenCalledOnce();
    expect(Speech.speak).toHaveBeenCalledWith("Read this", expect.any(Object));
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses on-device speech when the preference cannot be read, and never hosts the reply", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(Speech.speak).mockImplementation((_text, options) => options?.onDone?.());

    await expect(speakText("Read this")).resolves.toBe(true);

    expect(Speech.speak).toHaveBeenCalledWith("Read this", expect.any(Object));
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves false on empty text without calling the OS engine", async () => {
    await expect(speakWithDeviceVoice("   ")).resolves.toBe(false);
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it("rejects with the OS engine's own error instead of resolving false", async () => {
    vi.mocked(Speech.speak).mockImplementation((_text, options) =>
      options?.onError?.(new Error("synth failed")),
    );

    await expect(speakWithDeviceVoice("Hello")).rejects.toThrow("synth failed");
  });

  it("rejects when expo-speech is not usable instead of calling hosted voice", async () => {
    const originalSpeak = Speech.speak;
    Object.defineProperty(Speech, "speak", { configurable: true, value: undefined });
    try {
      await expect(speakWithDeviceVoice("Hello")).rejects.toThrow("Could not play that clip.");
      expect(rpc).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Speech, "speak", { configurable: true, value: originalSpeak });
    }
  });

  it("strips markdown and splits a long reply into bounded utterances, in order", async () => {
    const spoken: string[] = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      spoken.push(text);
      options?.onDone?.();
    });
    const longSentence = `${"word ".repeat(70).trim()}.`;
    const text = `**Bold** intro. ${longSentence} A short close.`;

    await expect(speakWithDeviceVoice(text)).resolves.toBe(true);

    expect(spoken.length).toBeGreaterThan(1);
    for (const utterance of spoken) {
      expect(utterance.length).toBeLessThan(500);
      expect(utterance).not.toContain("**");
    }
    expect(spoken.join(" ")).toContain("Bold intro");
  });

  it("stops queuing more chunks once a newer call interrupts it", async () => {
    const calls: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      calls.push({ text, options });
    });

    const first = speakWithDeviceVoice("First sentence. Second sentence.");
    await flushDeviceSpeechImport();
    expect(calls.map((c) => c.text)).toEqual(["First sentence."]);

    const second = speakWithDeviceVoice("Different message.");
    calls[0]?.options?.onStopped?.();
    await flushDeviceSpeechImport();

    expect(calls.map((c) => c.text)).not.toContain("Second sentence.");
    await expect(first).resolves.toBe(true);

    calls[1]?.options?.onDone?.();
    await expect(second).resolves.toBe(true);
    expect(calls.map((c) => c.text)).toEqual(["First sentence.", "Different message."]);
  });

  it("awaits Speech.stop before speaking and skips if a newer session started during stop", async () => {
    let releaseStop: () => void = () => undefined;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    vi.mocked(Speech.stop).mockReturnValue(stopPending);
    vi.mocked(Speech.speak).mockImplementation((_text, options) => options?.onDone?.());

    const first = speakWithDeviceVoice("Hello there.");
    await flushDeviceSpeechImport();
    expect(Speech.speak).not.toHaveBeenCalled();

    const second = speakWithDeviceVoice("Different message.");
    await flushDeviceSpeechImport();
    releaseStop();
    await flushDeviceSpeechImport();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(Speech.speak).toHaveBeenCalledOnce();
    expect(Speech.speak).toHaveBeenCalledWith("Different message.", expect.any(Object));
  });

  it("resolves true, not false, when interrupted on its final utterance", async () => {
    const calls: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      calls.push({ text, options });
    });

    const first = speakWithDeviceVoice("Only one sentence here.");
    await flushDeviceSpeechImport();
    expect(calls).toHaveLength(1);

    const second = speakWithDeviceVoice("Different message.");
    calls[0]?.options?.onStopped?.();
    await flushDeviceSpeechImport();

    await expect(first).resolves.toBe(true);

    calls[1]?.options?.onDone?.();
    await expect(second).resolves.toBe(true);
  });
});
