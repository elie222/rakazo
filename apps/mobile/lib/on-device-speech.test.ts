import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT_SILENCE_MS } from "./dictation";
import type { OnDeviceSpeechNative } from "./on-device-speech";
import {
  deleteOnDeviceSpeechModels,
  downloadOnDeviceSpeechModels,
  finishOnDeviceSpeech,
  floatSamplesToWavBase64,
  listenOnDeviceSpeech,
  loadOnDeviceSpeechEnabled,
  onDeviceSpeechAvailable,
  onDeviceSpeechModelSizes,
  onDeviceSpeechModelsStatus,
  saveOnDeviceSpeechEnabled,
  setOnDeviceSpeechNative,
  speakOnDeviceSpeech,
  stopOnDeviceSpeech,
  stopOnDeviceSpeechPlayback,
} from "./on-device-speech";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const sessionUser = { id: "user-1" };
vi.mock("./session", () => ({
  loadVerifiedIntegrationsScope: vi.fn(async () => ({
    apiBase: "https://api.example",
    userId: sessionUser.id,
    spaceId: "space-1",
    selectionId: null,
  })),
}));

const players: {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  emitFinish: () => void;
}[] = [];
vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(() => {
    const listeners = new Set<(status: Record<string, unknown>) => void>();
    const player = {
      play: vi.fn(() => {
        for (const listener of [...listeners]) listener({ didJustFinish: true });
      }),
      pause: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn((_event: string, listener: (status: Record<string, unknown>) => void) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      }),
      emitFinish: () => {
        for (const listener of [...listeners]) listener({ didJustFinish: true });
      },
    };
    players.push(player);
    return player;
  }),
  setAudioModeAsync: vi.fn(async () => undefined),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri = "file:///cache/rakazo-on-device-speech.wav";
    create() {}
    write() {}
    delete() {}
  },
  Paths: { cache: "cache" },
}));

type PcmListener = (samples: Float32Array, sampleRate: number) => void;

function fakeNative(
  options: {
    sttDownloaded?: boolean;
    ttsDownloaded?: boolean;
    sttPath?: string | null;
    ttsPath?: string | null;
    endpoint?: boolean;
  } = {},
) {
  const sttDownloaded = options.sttDownloaded ?? true;
  const ttsDownloaded = options.ttsDownloaded ?? true;
  const sttPath = options.sttPath === undefined ? "/models/stt" : options.sttPath;
  const ttsPath = options.ttsPath === undefined ? "/models/tts" : options.ttsPath;
  let text = "";
  let endpoint = options.endpoint ?? false;
  const dataListeners = new Set<PcmListener>();
  const errorListeners = new Set<(message: string) => void>();
  const stream = {
    processAudioChunk: vi.fn(async (_samples: Float32Array, _sampleRate: number) => ({
      result: { text },
      isEndpoint: endpoint,
    })),
    inputFinished: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const engine = {
    createStream: vi.fn(async () => stream),
    destroy: vi.fn(async () => undefined),
  };
  const pcm = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    onData: vi.fn((callback: PcmListener) => {
      dataListeners.add(callback);
      return () => dataListeners.delete(callback);
    }),
    onError: vi.fn((callback: (message: string) => void) => {
      errorListeners.add(callback);
      return () => errorListeners.delete(callback);
    }),
  };
  const ttsEngine = {
    generateSpeech: vi.fn(async (_text: string, _options?: { sid?: number }) => ({
      samples: [0.1, -0.2, 0.3, 0.0],
      sampleRate: 24000,
    })),
    destroy: vi.fn(async () => undefined),
  };
  const native: OnDeviceSpeechNative = {
    createStreamingStt: vi.fn(async () => engine),
    createPcmLiveStream: vi.fn(() => pcm),
    createTts: vi.fn(async () => ttsEngine),
    ensureModel: vi.fn(
      async (
        _category: string,
        _id: string,
        opts?: { onProgress?: (p: { percent: number; phase: string }) => void },
      ) => {
        opts?.onProgress?.({ percent: 100, phase: "downloading" });
        return { localPath: "/models/downloaded" };
      },
    ),
    isModelDownloaded: vi.fn(async (category: string) =>
      category === "stt" ? sttDownloaded : ttsDownloaded,
    ),
    getModelPath: vi.fn(async (category: string) => (category === "stt" ? sttPath : ttsPath)),
    deleteModel: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => []),
  };
  return {
    native,
    engine,
    stream,
    pcm,
    ttsEngine,
    hear: (next: string, end = false) => {
      text = next;
      endpoint = end;
      for (const listener of [...dataListeners]) listener(new Float32Array([0.1]), 16000);
    },
    failMic: (message = "mic failed") => {
      for (const listener of [...errorListeners]) listener(message);
    },
  };
}

let fake: ReturnType<typeof fakeNative>;

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  players.length = 0;
  sessionUser.id = "user-1";
  fake = fakeNative();
  setOnDeviceSpeechNative(fake.native);
});

afterEach(() => {
  stopOnDeviceSpeech();
  stopOnDeviceSpeechPlayback();
  setOnDeviceSpeechNative(null);
  vi.useRealTimers();
});

describe("on-device speech settings", () => {
  it("is off by default and keeps one choice per account", async () => {
    expect(await loadOnDeviceSpeechEnabled()).toBe(false);
    await saveOnDeviceSpeechEnabled(true);
    expect(await loadOnDeviceSpeechEnabled()).toBe(true);
    sessionUser.id = "user-2";
    expect(await loadOnDeviceSpeechEnabled()).toBe(false);
    sessionUser.id = "user-1";
    expect(await loadOnDeviceSpeechEnabled()).toBe(true);
    await saveOnDeviceSpeechEnabled(false);
    expect(await loadOnDeviceSpeechEnabled()).toBe(false);
  });

  it("reports the model download sizes", () => {
    expect(onDeviceSpeechModelSizes()).toEqual({ sttMb: 71, ttsMb: 141, totalMb: 212 });
  });
});

describe("on-device speech availability", () => {
  it("is false when switched off", async () => {
    expect(await onDeviceSpeechAvailable()).toBe(false);
  });

  it("is false when a model is missing", async () => {
    await saveOnDeviceSpeechEnabled(true);
    fake = fakeNative({ ttsDownloaded: false });
    setOnDeviceSpeechNative(fake.native);
    expect(await onDeviceSpeechAvailable()).toBe(false);
  });

  it("is true when switched on and both models are downloaded", async () => {
    await saveOnDeviceSpeechEnabled(true);
    expect(await onDeviceSpeechAvailable()).toBe(true);
    expect(fake.native.isModelDownloaded).toHaveBeenCalledWith("stt", expect.any(String));
    expect(fake.native.isModelDownloaded).toHaveBeenCalledWith("tts", expect.any(String));
  });
});

describe("on-device speech dictation", () => {
  it("reports interim text and finishes on endpoint", async () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    await listenOnDeviceSpeech({ onInterim, onFinal });
    fake.hear("你好");
    await vi.advanceTimersByTimeAsync(0);
    expect(onInterim).toHaveBeenCalledWith("你好");
    fake.hear("你好世界", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFinal).toHaveBeenCalledWith("你好世界");
  });

  it("finishes the turn after the quiet gap when no endpoint fires", async () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    await listenOnDeviceSpeech({ onInterim, onFinal });
    fake.hear("你好");
    await vi.advanceTimersByTimeAsync(0);
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);
    expect(onFinal).toHaveBeenCalledWith("你好");
  });

  it("delivers what was heard when finished early", async () => {
    const onFinal = vi.fn();
    await listenOnDeviceSpeech({ onFinal });
    fake.hear("你好");
    await vi.advanceTimersByTimeAsync(0);
    finishOnDeviceSpeech();
    expect(onFinal).toHaveBeenCalledWith("你好");
  });

  it("stops without delivering when nothing was heard", async () => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listenOnDeviceSpeech({ onFinal, onGiveUp });
    stopOnDeviceSpeech();
    await vi.advanceTimersByTimeAsync(0);
    expect(onFinal).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up when the speech model is not downloaded", async () => {
    fake = fakeNative({ sttPath: null });
    setOnDeviceSpeechNative(fake.native);
    const onGiveUp = vi.fn();
    await listenOnDeviceSpeech({ onFinal: vi.fn(), onGiveUp });
    expect(onGiveUp).toHaveBeenCalledWith("failed");
    expect(fake.native.createStreamingStt).not.toHaveBeenCalled();
  });

  it("gives up when the recognizer cannot start", async () => {
    fake.native.createStreamingStt = vi.fn(async () => {
      throw new Error("no engine");
    });
    const onGiveUp = vi.fn();
    await listenOnDeviceSpeech({ onFinal: vi.fn(), onGiveUp });
    expect(onGiveUp).toHaveBeenCalledWith("failed");
  });

  it("gives up when the microphone errors", async () => {
    const onGiveUp = vi.fn();
    await listenOnDeviceSpeech({ onFinal: vi.fn(), onGiveUp });
    fake.failMic();
    await vi.advanceTimersByTimeAsync(0);
    expect(onGiveUp).toHaveBeenCalledWith("failed");
  });
});

describe("on-device speech read-aloud", () => {
  it("synthesizes and plays the text", async () => {
    const spoken = await speakOnDeviceSpeech("你好世界");
    expect(spoken).toBe(true);
    expect(fake.ttsEngine.generateSpeech).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sid: expect.any(Number) }),
    );
    expect(players.length).toBeGreaterThan(0);
  });

  it("is silent for text with nothing to say", async () => {
    expect(await speakOnDeviceSpeech("   ")).toBe(false);
    expect(fake.ttsEngine.generateSpeech).not.toHaveBeenCalled();
  });

  it("is silent when the voice model is not downloaded", async () => {
    fake = fakeNative({ ttsPath: null });
    setOnDeviceSpeechNative(fake.native);
    expect(await speakOnDeviceSpeech("你好")).toBe(false);
    expect(fake.ttsEngine.generateSpeech).not.toHaveBeenCalled();
  });
});

describe("on-device speech models", () => {
  it("reports which models are on disk", async () => {
    expect(await onDeviceSpeechModelsStatus()).toEqual({
      stt: "ready",
      tts: "ready",
      progress: null,
    });
    fake = fakeNative({ sttDownloaded: false, ttsDownloaded: false });
    setOnDeviceSpeechNative(fake.native);
    expect(await onDeviceSpeechModelsStatus()).toEqual({
      stt: "missing",
      tts: "missing",
      progress: null,
    });
  });

  it("downloads both models and reports progress", async () => {
    const seen: number[] = [];
    await downloadOnDeviceSpeechModels((status) => {
      if (status.progress !== null) seen.push(status.progress);
    });
    expect(fake.native.ensureModel).toHaveBeenCalledTimes(2);
    expect(fake.native.ensureModel).toHaveBeenNthCalledWith(
      1,
      "stt",
      expect.any(String),
      expect.anything(),
    );
    expect(fake.native.ensureModel).toHaveBeenNthCalledWith(
      2,
      "tts",
      expect.any(String),
      expect.anything(),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("refreshes the model lists before downloading", async () => {
    await downloadOnDeviceSpeechModels();
    expect(fake.native.refreshModels).toHaveBeenNthCalledWith(1, "stt");
    expect(fake.native.refreshModels).toHaveBeenNthCalledWith(2, "tts");
    // Without the refresh the download manager's cache starts empty and
    // ensureModel throws "Unknown model id".
    const refreshOrder = vi.mocked(fake.native.refreshModels).mock.invocationCallOrder;
    const ensureOrder = vi.mocked(fake.native.ensureModel).mock.invocationCallOrder;
    expect(refreshOrder[0]!).toBeLessThan(ensureOrder[0]!);
  });

  it("deletes both models", async () => {
    await deleteOnDeviceSpeechModels();
    expect(fake.native.deleteModel).toHaveBeenCalledWith("stt", expect.any(String));
    expect(fake.native.deleteModel).toHaveBeenCalledWith("tts", expect.any(String));
  });
});

describe("floatSamplesToWavBase64", () => {
  it("writes a 16-bit PCM WAV header for the samples", () => {
    const base64 = floatSamplesToWavBase64([0.5, -0.5, 0], 16000);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...bytes.subarray(start, end));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 12)).toBe("WAVE");
    expect(ascii(12, 16)).toBe("fmt ");
    expect(ascii(36, 40)).toBe("data");
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(bytes.length).toBe(44 + 6);
  });
});
