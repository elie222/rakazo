import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import {
  getVoicePlaybackState,
  MAX_VOICE_AUDIO_BYTES,
  pauseVoicePlayback,
  playMpeg,
  resumeVoicePlayback,
  speakQueue,
  speakText,
  speakUtterance,
  speakWithDeviceVoice,
  stopVoicePlayback,
  subscribeVoicePlayback,
  VOICE_RESPONSE_TIMEOUT_MS,
} from "./voice";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-speech", () => ({
  speak: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getAvailableVoicesAsync: vi.fn().mockResolvedValue([]),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./api", () => ({
  aiConsentCoalesceKey: vi.fn(() => "test-consent-context"),
  authHeaders: vi.fn(),
  captureApiRequestContext: vi.fn(),
  currentApiBase: vi.fn(() => "https://api.example"),
  rpc: vi.fn(),
}));

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("waitFor: condition was never met");
}

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

class ControllableAudio {
  static instances: ControllableAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;

  constructor() {
    ControllableAudio.instances.push(this);
  }

  async play() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

describe("hosted voice playback controls", () => {
  beforeEach(() => {
    ControllableAudio.instances = [];
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    vi.mocked(captureApiRequestContext).mockResolvedValue({
      apiBase: "https://support.example",
      headers: { authorization: "Bearer support-token", "x-rakazo-space-id": "space-support" },
    });
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      return { ready: true, utterances: ["First", "Second"] } as never;
    });
    vi.stubGlobal("Audio", ControllableAudio);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports idle with no control before anything is speaking", () => {
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    expect(() => pauseVoicePlayback()).not.toThrow();
    expect(() => stopVoicePlayback()).not.toThrow();
    expect(() => resumeVoicePlayback()).not.toThrow();
  });

  it("pauses and resumes the current clip through the shared control", async () => {
    const spoken = speakText("Read this", { botId: "bot-1" });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);
    expect(getVoicePlaybackState()).toEqual({ status: "playing", botId: "bot-1", canPause: true });

    pauseVoicePlayback();
    expect(audio.paused).toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "paused", botId: "bot-1", canPause: true });

    resumeVoicePlayback();
    await waitFor(() => audio.paused === false);
    expect(getVoicePlaybackState()).toEqual({ status: "playing", botId: "bot-1", canPause: true });

    audio.onended?.();
    await waitFor(() => ControllableAudio.instances.length > 1);
    const secondAudio = ControllableAudio.instances[1]!;
    await waitFor(() => secondAudio.paused === false);
    secondAudio.onended?.();

    await expect(spoken).resolves.toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
  });

  it("carries a pause across the gap between utterances", async () => {
    const spoken = speakText("Read this", { botId: "bot-1" });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);

    pauseVoicePlayback();
    audio.onended?.();
    await waitFor(() => ControllableAudio.instances.length > 1);
    const secondAudio = ControllableAudio.instances[1]!;
    // The next utterance's player must start paused, not play out from under the user.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondAudio.paused).toBe(true);

    resumeVoicePlayback();
    await waitFor(() => secondAudio.paused === false);
    secondAudio.onended?.();
    await expect(spoken).resolves.toBe(true);
  });

  it("stops immediately and resolves the call without playing further utterances", async () => {
    const spoken = speakText("Read this", { botId: "bot-1" });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);

    stopVoicePlayback();
    expect(audio.paused).toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });

    await expect(spoken).resolves.toBe(true);
    expect(ControllableAudio.instances).toHaveLength(1);
  });

  it("plays a queue of messages in order, one after another, to the last one", async () => {
    // One utterance per call (instead of the shared beforeEach's fixed two),
    // so each queue item maps to exactly one ControllableAudio instance below.
    vi.mocked(rpc).mockImplementation(async (proc, body) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      const text = (body as { text?: string } | undefined)?.text ?? "";
      return { ready: true, utterances: [text] } as never;
    });
    const played: Array<string | undefined> = [];
    const queued = speakQueue([
      { text: "First", botId: "bot-1", messageId: "msg-1" },
      { text: "Second", botId: "bot-1", messageId: "msg-2" },
      { text: "Third", botId: "bot-1", messageId: "msg-3" },
    ]);

    for (let i = 0; i < 3; i++) {
      await waitFor(() => ControllableAudio.instances.length > i);
      const audio = ControllableAudio.instances[i]!;
      await waitFor(() => audio.paused === false);
      played.push(getVoicePlaybackState().messageId);
      audio.onended?.();
    }

    await queued;
    expect(played).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(getVoicePlaybackState().status).toBe("idle");
  });

  it("reports that nothing was spoken, and stops, when the voice is not ready", async () => {
    vi.mocked(rpc).mockClear();
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      return { ready: false, utterances: [] } as never;
    });
    await expect(
      speakQueue([
        { text: "First", botId: "bot-1", messageId: "msg-1" },
        { text: "Second", botId: "bot-1", messageId: "msg-2" },
      ]),
    ).resolves.toBe(false);
    expect(ControllableAudio.instances).toHaveLength(0);
    expect(vi.mocked(rpc).mock.calls.filter(([proc]) => proc === "voice/prepare")).toHaveLength(1);
  });

  it("stops a queue immediately and never starts the remaining messages", async () => {
    const queued = speakQueue([
      { text: "First", botId: "bot-1", messageId: "msg-1" },
      { text: "Second", botId: "bot-1", messageId: "msg-2" },
    ]);
    await waitFor(() => ControllableAudio.instances.length > 0);
    await waitFor(() => ControllableAudio.instances[0]!.paused === false);

    stopVoicePlayback();
    await queued;

    expect(getVoicePlaybackState().status).toBe("idle");
    expect(ControllableAudio.instances).toHaveLength(1);
  });

  it("notifies subscribers on every status change, and stops after unsubscribing", async () => {
    const notify = vi.fn();
    const unsubscribe = subscribeVoicePlayback(notify);
    const spoken = speakText("Read this", { botId: "bot-1" });
    await waitFor(() => ControllableAudio.instances.length > 0);
    expect(notify).toHaveBeenCalled();

    notify.mockClear();
    stopVoicePlayback();
    expect(notify).toHaveBeenCalledTimes(1);
    await spoken;

    unsubscribe();
    notify.mockClear();
    const spokenAgain = speakText("Different", { botId: "bot-2" });
    await waitFor(() => ControllableAudio.instances.length > 1);
    stopVoicePlayback();
    await spokenAgain;

    expect(notify).not.toHaveBeenCalled();
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
    vi.mocked(Speech.pause).mockReset();
    vi.mocked(Speech.resume).mockReset();
    vi.mocked(Speech.getAvailableVoicesAsync).mockReset().mockResolvedValue([]);
    vi.mocked(rpc).mockReset();
    Platform.OS = "ios";
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

  it("can pause and resume on iOS, where the OS engine supports it", async () => {
    Platform.OS = "ios";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    let finishUtterance: () => void = () => undefined;
    vi.mocked(Speech.speak).mockImplementation((_text, options) => {
      finishUtterance = () => options?.onDone?.();
    });

    const spoken = speakWithDeviceVoice("Hello", "bot-1");
    await flushDeviceSpeechImport();
    expect(getVoicePlaybackState()).toEqual({ status: "playing", botId: "bot-1", canPause: true });

    pauseVoicePlayback();
    expect(vi.mocked(Speech.pause)).toHaveBeenCalledOnce();
    expect(getVoicePlaybackState()).toEqual({ status: "paused", botId: "bot-1", canPause: true });

    resumeVoicePlayback();
    expect(vi.mocked(Speech.resume)).toHaveBeenCalledOnce();
    expect(getVoicePlaybackState()).toEqual({ status: "playing", botId: "bot-1", canPause: true });

    finishUtterance();
    await expect(spoken).resolves.toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
  });

  it("prefers a higher-quality network voice on Android, and caches the choice per language", async () => {
    Platform.OS = "android";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    vi.mocked(Speech.getAvailableVoicesAsync).mockResolvedValue([
      { identifier: "en-us-x-iol-local", name: "English (local)", language: "en-US" },
      { identifier: "en-us-x-iol-network", name: "English (network)", language: "en-US" },
    ] as never);
    const calls: Array<Parameters<typeof Speech.speak>[1]> = [];
    vi.mocked(Speech.speak).mockImplementation((_text, options) => {
      calls.push(options);
      options?.onDone?.();
    });

    await expect(speakWithDeviceVoice("Hello")).resolves.toBe(true);
    expect(calls[0]?.voice).toBe("en-us-x-iol-network");
    expect(calls[0]?.language).toBe("en-US");

    vi.mocked(Speech.getAvailableVoicesAsync).mockClear();
    await expect(speakWithDeviceVoice("Hello again")).resolves.toBe(true);
    expect(Speech.getAvailableVoicesAsync).not.toHaveBeenCalled();
    expect(calls[1]?.voice).toBe("en-us-x-iol-network");
  });

  it("falls back to the platform default voice when no network voice is installed", async () => {
    Platform.OS = "android";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    const { activateUiLocale } = await import("./i18n");
    activateUiLocale("zh-CN"); // a language not cached by the test above
    vi.mocked(Speech.getAvailableVoicesAsync).mockResolvedValue([
      { identifier: "zh-cn-x-local", name: "Chinese (local)", language: "zh-CN" },
    ] as never);
    const calls: Array<Parameters<typeof Speech.speak>[1]> = [];
    vi.mocked(Speech.speak).mockImplementation((_text, options) => {
      calls.push(options);
      options?.onDone?.();
    });

    try {
      await expect(speakWithDeviceVoice("Hello")).resolves.toBe(true);
      expect(calls[0]?.voice).toBeUndefined();
    } finally {
      activateUiLocale("en");
    }
  });

  it("does not fail speech when the voice list cannot be read", async () => {
    Platform.OS = "android";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    const { activateUiLocale } = await import("./i18n");
    activateUiLocale("ru"); // a language not cached by earlier tests
    vi.mocked(Speech.getAvailableVoicesAsync).mockRejectedValue(new Error("no TTS engine"));
    vi.mocked(Speech.speak).mockImplementation((_text, options) => options?.onDone?.());

    try {
      await expect(speakWithDeviceVoice("Hello")).resolves.toBe(true);
    } finally {
      activateUiLocale("en");
    }
  });

  it("cannot pause on Android, only stop, and pausing there is a no-op", async () => {
    Platform.OS = "android";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    let finishUtterance: () => void = () => undefined;
    vi.mocked(Speech.speak).mockImplementation((_text, options) => {
      finishUtterance = () => options?.onDone?.();
    });

    const spoken = speakWithDeviceVoice("Hello", "bot-1");
    await flushDeviceSpeechImport();

    pauseVoicePlayback();
    expect(vi.mocked(Speech.pause)).not.toHaveBeenCalled();
    expect(getVoicePlaybackState().status).toBe("playing");
    expect(getVoicePlaybackState().canPause).toBe(false);

    finishUtterance();
    await expect(spoken).resolves.toBe(true);
  });

  it("stops immediately on Stop, interrupting the remaining utterances", async () => {
    Platform.OS = "android";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    const spoken: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      spoken.push({ text, options });
    });

    const call = speakWithDeviceVoice("First sentence. Second sentence.", "bot-1");
    await flushDeviceSpeechImport();
    expect(spoken.map((s) => s.text)).toEqual(["First sentence."]);

    stopVoicePlayback();
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });

    spoken[0]?.options?.onStopped?.();
    await expect(call).resolves.toBe(true);
    expect(spoken.map((s) => s.text)).toEqual(["First sentence."]);
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
