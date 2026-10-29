import { MAX_VOICE_AUDIO_BYTES, VOICE_RESPONSE_TIMEOUT_MS } from "@rakazo/core";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import {
  createSpeechOwner,
  getVoicePlaybackState,
  pauseVoicePlayback,
  playSpeechClip,
  resumeVoicePlayback,
  speakQueue,
  speakText,
  speakUtterance,
  speakWithDeviceVoice,
  speechClipType,
  stopSpeaking,
  stopVoicePlayback,
  subscribeVoicePlayback,
} from "./voice";

vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: "en-US" }] }));

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    uri = "file:///cache/rakazo-voice.mp3";
    create() {}
    write() {}
    delete() {}
  },
  Paths: { cache: "cache" },
}));
vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(async () => undefined),
}));
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

  it("plays WAV from a server that renders speech itself and MP3 otherwise", () => {
    const wav = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");
    expect(speechClipType(wav)).toEqual({ mimeType: "audio/wav", extension: "wav" });
    expect(speechClipType(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toEqual({
      mimeType: "audio/mpeg",
      extension: "mp3",
    });
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

    await expect(playSpeechClip(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
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

  it("carries who is speaking through pause and resume, and not to another bot", async () => {
    const speaker = { name: "Ada", color: "#123456" };
    const spoken = speakText("Read this", { botId: "bot-1", speaker });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);
    expect(getVoicePlaybackState().speaker).toEqual(speaker);

    pauseVoicePlayback();
    expect(getVoicePlaybackState()).toMatchObject({ status: "paused", speaker });
    resumeVoicePlayback();
    await waitFor(() => audio.paused === false);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", speaker });

    stopVoicePlayback();
    await expect(spoken).resolves.toBe(true);

    const other = speakText("Read that", { botId: "bot-2" });
    await waitFor(() => ControllableAudio.instances.length > 1);
    expect(getVoicePlaybackState().speaker).toBeUndefined();
    stopVoicePlayback();
    await other;
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

  it("renders the next utterance while the current clip is still playing", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: unknown }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        requested.push(body.text ?? "");
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );

    const spoken = speakText("Read this", { botId: "bot-1" });
    await waitFor(() => ControllableAudio.instances.length === 1);
    const firstAudio = ControllableAudio.instances[0]!;
    await waitFor(() => firstAudio.paused === false);

    await waitFor(() => requested.length === 2);
    expect(requested).toEqual(["First", "Second"]);
    expect(ControllableAudio.instances).toHaveLength(1);

    firstAudio.onended?.();
    await waitFor(() => ControllableAudio.instances.length === 2);
    const secondAudio = ControllableAudio.instances[1]!;
    await waitFor(() => secondAudio.paused === false);
    secondAudio.onended?.();

    await expect(spoken).resolves.toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
  });

  it("surfaces a prefetched clip's failure when playback reaches it, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("Offline.");
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );

    try {
      const spoken = speakText("Read this", { botId: "bot-1" });
      const outcome = spoken.then(
        () => "spoken",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await waitFor(() => ControllableAudio.instances.length === 1);
      const firstAudio = ControllableAudio.instances[0]!;
      await waitFor(() => firstAudio.paused === false);
      await waitFor(() => calls === 2);
      expect(ControllableAudio.instances).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);

      firstAudio.onended?.();
      await expect(outcome).resolves.toBe("Offline.");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      stopVoicePlayback();
    }
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
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    expect(vi.mocked(rpc).mock.calls.filter(([proc]) => proc === "voice/prepare")).toHaveLength(1);
  });

  it("shows Stop while the first clip is still preparing, and idle if Stop cancels it", async () => {
    let releasePrepare: (() => void) | undefined;
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      await new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      return { ready: true, utterances: ["Read this"] } as never;
    });

    const spoken = speakText("Read this", { botId: "bot-1", messageId: "msg-1" });
    await waitFor(() => releasePrepare !== undefined);
    expect(getVoicePlaybackState()).toEqual({
      status: "playing",
      botId: "bot-1",
      messageId: "msg-1",
      canPause: false,
    });
    expect(ControllableAudio.instances).toHaveLength(0);

    stopVoicePlayback();
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    releasePrepare?.();
    await expect(spoken).resolves.toBe(false);
    expect(ControllableAudio.instances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("clears the dock when voice prepare rejects", async () => {
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      throw new Error("prepare failed");
    });

    await expect(speakText("Read this", { botId: "bot-1", messageId: "msg-1" })).rejects.toThrow(
      "prepare failed",
    );
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
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

  it("stops the clip already playing when another speakText starts", async () => {
    const first = speakText("Read this", { botId: "bot-1", messageId: "msg-1" });
    await waitFor(() => ControllableAudio.instances.length === 1);
    const firstAudio = ControllableAudio.instances[0]!;
    await waitFor(() => firstAudio.paused === false);

    const second = speakText("Other", { botId: "bot-2", messageId: "msg-2" });
    expect(firstAudio.paused).toBe(true);

    await waitFor(() => ControllableAudio.instances.length === 2);
    const secondAudio = ControllableAudio.instances[1]!;
    await waitFor(() => secondAudio.paused === false);
    expect(getVoicePlaybackState()).toMatchObject({
      status: "playing",
      messageId: "msg-2",
      canPause: true,
    });
    expect(ControllableAudio.instances.filter((audio) => !audio.paused)).toEqual([secondAudio]);

    secondAudio.onended?.();
    await waitFor(() => ControllableAudio.instances.length === 3);
    const secondTail = ControllableAudio.instances[2]!;
    await waitFor(() => secondTail.paused === false);
    expect(firstAudio.paused).toBe(true);
    secondTail.onended?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(ControllableAudio.instances).toHaveLength(3);
    expect(getVoicePlaybackState().status).toBe("idle");
  });

  it("drops a queue that is already running when a new queue starts", async () => {
    vi.mocked(rpc).mockImplementation(async (proc, body) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      const text = (body as { text?: string } | undefined)?.text ?? "";
      return { ready: true, utterances: [text] } as never;
    });
    const first = speakQueue([
      { text: "A1", botId: "bot-1", messageId: "a1" },
      { text: "A2", botId: "bot-1", messageId: "a2" },
      { text: "A3", botId: "bot-1", messageId: "a3" },
    ]);
    await waitFor(() => ControllableAudio.instances.length === 1);
    await waitFor(() => ControllableAudio.instances[0]!.paused === false);

    const second = speakQueue([
      { text: "B1", botId: "bot-1", messageId: "b1" },
      { text: "B2", botId: "bot-1", messageId: "b2" },
    ]);
    expect(ControllableAudio.instances[0]!.paused).toBe(true);

    const played: Array<string | undefined> = [];
    const seen = new Set<ControllableAudio>([ControllableAudio.instances[0]!]);
    for (let step = 0; step < 40 && played.length < 2; step++) {
      await Promise.resolve();
      for (const audio of ControllableAudio.instances) {
        if (seen.has(audio) || audio.paused) continue;
        seen.add(audio);
        played.push(getVoicePlaybackState().messageId);
        audio.onended?.();
      }
    }

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(played).toEqual(["b1", "b2"]);
    expect(ControllableAudio.instances).toHaveLength(3);
    expect(getVoicePlaybackState().status).toBe("idle");
  });

  it("does not play the next queued message when Stop lands while it is preparing", async () => {
    let releasePrepare: (() => void) | undefined;
    let prepareCalls = 0;
    vi.mocked(rpc).mockImplementation(async (proc, body) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      prepareCalls += 1;
      if (prepareCalls === 2) {
        await new Promise<void>((resolve) => {
          releasePrepare = resolve;
        });
      }
      const text = (body as { text?: string } | undefined)?.text ?? "";
      return { ready: true, utterances: [text] } as never;
    });

    const queued = speakQueue([
      { text: "First", botId: "bot-1", messageId: "msg-1" },
      { text: "Second", botId: "bot-1", messageId: "msg-2" },
    ]);
    await waitFor(() => ControllableAudio.instances.length === 1);
    await waitFor(() => ControllableAudio.instances[0]!.paused === false);
    ControllableAudio.instances[0]!.onended?.();
    await waitFor(() => prepareCalls === 2);
    expect(getVoicePlaybackState().status).toBe("playing");

    stopVoicePlayback();
    expect(getVoicePlaybackState().status).toBe("idle");
    releasePrepare?.();
    for (let step = 0; step < 20; step++) await Promise.resolve();
    if (ControllableAudio.instances.length > 1) ControllableAudio.instances[1]!.onended?.();

    await expect(queued).resolves.toBe(true);
    expect(ControllableAudio.instances).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("stops any speech when stopSpeaking has no owner", async () => {
    const spoken = speakText("Read this", { botId: "bot-1", messageId: "msg-1" });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);

    stopSpeaking();
    expect(audio.paused).toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    await expect(spoken).resolves.toBe(true);
  });

  it("stops the speech its owner started, like a call hanging up", async () => {
    const owner = createSpeechOwner();
    const spoken = speakText("Read this", { botId: "bot-1", messageId: "msg-1", owner });
    await waitFor(() => ControllableAudio.instances.length > 0);
    const audio = ControllableAudio.instances[0]!;
    await waitFor(() => audio.paused === false);

    stopSpeaking(owner);
    expect(audio.paused).toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    await expect(spoken).resolves.toBe(true);
    expect(ControllableAudio.instances).toHaveLength(1);
  });

  it("does not stop or clear a queue that replaced the owner's speech", async () => {
    vi.mocked(rpc).mockImplementation(async (proc, body) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      const text = (body as { text?: string } | undefined)?.text ?? "";
      return { ready: true, utterances: [text] } as never;
    });
    const owner = createSpeechOwner();
    const call = speakText("Call reply", { botId: "bot-1", messageId: "call-1", owner });
    await waitFor(() => ControllableAudio.instances.length === 1);
    await waitFor(() => ControllableAudio.instances[0]!.paused === false);

    const queued = speakQueue([
      { text: "First", botId: "bot-2", messageId: "msg-1" },
      { text: "Second", botId: "bot-2", messageId: "msg-2" },
    ]);
    await expect(call).resolves.toBe(true);
    await waitFor(() => ControllableAudio.instances.length === 2);
    const first = ControllableAudio.instances[1]!;
    await waitFor(() => first.paused === false);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "msg-1" });

    // The call hangs up: its stop must not cut the queue or drop its remaining item.
    stopSpeaking(owner);
    expect(first.paused).toBe(false);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "msg-1" });

    first.onended?.();
    await waitFor(() => ControllableAudio.instances.length === 3);
    const second = ControllableAudio.instances[2]!;
    await waitFor(() => second.paused === false);
    expect(getVoicePlaybackState()).toMatchObject({ messageId: "msg-2" });
    second.onended?.();

    await expect(queued).resolves.toBe(true);
    expect(getVoicePlaybackState().status).toBe("idle");
  });

  it("cancels its own speech while it is still preparing", async () => {
    const gates: Array<() => void> = [];
    vi.mocked(rpc).mockImplementation(async (proc) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      return { ready: true, utterances: ["Read this"] } as never;
    });
    const owner = createSpeechOwner();
    const spoken = speakText("Read this", { botId: "bot-1", messageId: "msg-1", owner });
    await waitFor(() => gates.length === 1);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "msg-1" });
    expect(ControllableAudio.instances).toHaveLength(0);

    stopSpeaking(owner);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    gates[0]!();
    await expect(spoken).resolves.toBe(false);
    expect(ControllableAudio.instances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does not let a stale owner stop a newer unrelated preparation", async () => {
    const gates: Array<() => void> = [];
    vi.mocked(rpc).mockImplementation(async (proc, body) => {
      if (proc === "aiConsent/status") return { version: "2026-09-14", recipients: [] } as never;
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      const text = (body as { text?: string } | undefined)?.text ?? "";
      return { ready: true, utterances: [text] } as never;
    });
    const owner = createSpeechOwner();
    const call = speakText("Call reply", { botId: "bot-1", messageId: "call-1", owner });
    await waitFor(() => gates.length === 1);
    gates[0]!();
    await waitFor(() => ControllableAudio.instances.length === 1);
    await waitFor(() => ControllableAudio.instances[0]!.paused === false);

    const other = speakText("Other text", { botId: "bot-2", messageId: "msg-2" });
    await waitFor(() => gates.length === 2);
    expect(ControllableAudio.instances[0]!.paused).toBe(true);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "msg-2" });

    // Hanging up mid-preparation must not cancel the newer speech.
    stopSpeaking(owner);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "msg-2" });

    gates[1]!();
    await waitFor(() => ControllableAudio.instances.length === 2);
    const audio = ControllableAudio.instances[1]!;
    await waitFor(() => audio.paused === false);
    audio.onended?.();
    await expect(other).resolves.toBe(true);
    await expect(call).resolves.toBe(true);
  });

  it("does not fail a paused native clip when the startup watchdog elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("Audio", undefined);
    class NativePlayer {
      static instances: NativePlayer[] = [];
      playing = false;
      private listeners = new Set<(status: Record<string, unknown>) => void>();

      constructor() {
        NativePlayer.instances.push(this);
      }

      play() {
        this.playing = true;
      }

      pause() {
        this.playing = false;
      }

      release() {}

      addListener(_event: string, listener: (status: Record<string, unknown>) => void) {
        this.listeners.add(listener);
        return { remove: () => this.listeners.delete(listener) };
      }
    }
    NativePlayer.instances = [];
    vi.mocked(createAudioPlayer).mockImplementation(
      () => new NativePlayer() as unknown as ReturnType<typeof createAudioPlayer>,
    );

    let spoken: Promise<boolean> | undefined;
    try {
      spoken = speakText("Read this", { botId: "bot-1" });
      await waitFor(() => NativePlayer.instances.length === 1);
      const player = NativePlayer.instances[0]!;
      await waitFor(() => player.playing);
      expect(setAudioModeAsync).toHaveBeenCalledWith({
        playsInSilentMode: true,
        interruptionMode: "mixWithOthers",
        shouldPlayInBackground: false,
      });

      pauseVoicePlayback();
      expect(getVoicePlaybackState()).toEqual({
        status: "paused",
        botId: "bot-1",
        canPause: true,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(player.playing).toBe(false);
      expect(getVoicePlaybackState()).toEqual({
        status: "paused",
        botId: "bot-1",
        canPause: true,
      });

      resumeVoicePlayback();
      expect(player.playing).toBe(true);
      const rejected = expect(spoken).rejects.toThrow("Could not play that clip.");
      await vi.advanceTimersByTimeAsync(14_000);
      expect(getVoicePlaybackState().status).toBe("playing");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
    } finally {
      stopVoicePlayback();
      await spoken?.catch(() => undefined);
      vi.useRealTimers();
    }
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

  it("speaks with the platform default voice and does not select a network voice", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    for (const os of ["ios", "android"] as const) {
      Platform.OS = os;
      const calls: Array<Parameters<typeof Speech.speak>[1]> = [];
      vi.mocked(Speech.speak).mockImplementation((_text, options) => {
        calls.push(options);
        options?.onDone?.();
      });

      await expect(speakWithDeviceVoice("Bonjour")).resolves.toBe(true);

      expect(Speech.getAvailableVoicesAsync).not.toHaveBeenCalled();
      expect(calls[0]?.voice).toBeUndefined();
      expect(calls[0]?.language).toBeUndefined();
      expect(rpc).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      vi.mocked(Speech.speak).mockReset();
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

  it("does not continue a reply after playback is stopped for a voice sample", async () => {
    Platform.OS = "ios";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    const spoken: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      spoken.push({ text, options });
    });
    vi.mocked(Speech.stop).mockResolvedValue(undefined);

    const call = speakWithDeviceVoice("First sentence. Second sentence.", "bot-1");
    await flushDeviceSpeechImport();
    expect(spoken.map((s) => s.text)).toEqual(["First sentence."]);

    stopVoicePlayback();
    await Speech.stop();
    Speech.speak("Hi, this is how I'll sound.", { voice: "sample" });
    spoken[0]?.options?.onStopped?.();
    await expect(call).resolves.toBe(true);
    expect(spoken.map((s) => s.text)).toEqual(["First sentence.", "Hi, this is how I'll sound."]);
  });

  it("does not stop a device voice sample that replaced the owner's speech", async () => {
    Platform.OS = "ios";
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("1");
    const utterances: Array<{ text: string; done: () => void; stopped: () => void }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({
        text,
        done: () => options?.onDone?.(),
        stopped: () => options?.onStopped?.(),
      });
    });
    vi.mocked(Speech.stop).mockResolvedValue(undefined);

    const owner = createSpeechOwner();
    const call = speakText("Call reply.", { botId: "bot-1", owner });
    await flushDeviceSpeechImport();
    expect(utterances.map((u) => u.text)).toEqual(["Call reply."]);

    const sample = speakWithDeviceVoice("Hi, this is how I'll sound.", "bot-1");
    await flushDeviceSpeechImport();
    expect(utterances.map((u) => u.text)).toEqual(["Call reply.", "Hi, this is how I'll sound."]);
    // One stop started the call's speech; replacing it and starting the sample stopped twice more.
    const stops = vi.mocked(Speech.stop).mock.calls.length;

    // Hanging up the call must not cut the sample that replaced its speech.
    stopSpeaking(owner);
    expect(Speech.stop).toHaveBeenCalledTimes(stops);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-1" });

    utterances[1]!.done();
    await expect(sample).resolves.toBe(true);
    // The superseded call speech settles as not spoken, not as a voice setup failure.
    utterances[0]!.stopped();
    await expect(call).resolves.toBe(false);
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
