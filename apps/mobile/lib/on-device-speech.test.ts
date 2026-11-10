import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT_SILENCE_MS } from "./dictation";
import type { OnDeviceSpeechNative } from "./on-device-speech";
import {
  deleteOnDeviceSpeechModels,
  downloadOnDeviceSpeechModelFromAddress,
  downloadOnDeviceSpeechModels,
  downloadOnDeviceSpeechModelsFromAddress,
  finishOnDeviceSpeech,
  floatSamplesToWavBase64,
  importOnDeviceSpeechModel,
  listenOnDeviceSpeech,
  loadOnDeviceSpeechEnabled,
  loadOnDeviceSpeechModelBaseUrl,
  onDeviceSpeechAvailable,
  onDeviceSpeechModelSizes,
  onDeviceSpeechModelsStatus,
  saveOnDeviceSpeechEnabled,
  saveOnDeviceSpeechModelBaseUrl,
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
vi.mock("./i18n", () => ({
  t: (text: string, vars?: Record<string, string | number>) =>
    vars
      ? Object.entries(vars).reduce(
          (out, [key, value]) => out.replaceAll(`{${key}}`, String(value)),
          text,
        )
      : text,
}));
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
const fsState = vi.hoisted(() => ({
  files: new Set<string>(),
  copies: [] as Array<{ from: string; to: string }>,
  downloads: [] as Array<{ url: string; to: string }>,
  createdDirs: [] as string[],
  deleted: [] as string[],
}));
vi.mock("expo-file-system", () => {
  const joinUri = (...parts: unknown[]): string => {
    const strings = parts.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (part && typeof part === "object" && "uri" in part) return [String(part.uri)];
      return [];
    });
    let out = "";
    for (const segment of strings) {
      if (!segment) continue;
      out = out ? `${out.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}` : segment;
    }
    return out;
  };
  class FakeFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = joinUri(...parts);
    }
    get exists() {
      return fsState.files.has(this.uri);
    }
    create() {
      fsState.files.add(this.uri);
    }
    write() {
      fsState.files.add(this.uri);
    }
    async copy(target: FakeFile) {
      fsState.copies.push({ from: this.uri, to: target.uri });
      fsState.files.add(target.uri);
    }
    delete() {
      fsState.files.delete(this.uri);
      fsState.deleted.push(this.uri);
    }
    static createDownloadTask(url: string, destination: FakeFile) {
      fsState.downloads.push({ url, to: destination.uri });
      return {
        downloadAsync: async () => {
          fsState.files.add(destination.uri);
          return { uri: destination.uri };
        },
        release: () => undefined,
      };
    }
  }
  class FakeDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = joinUri(...parts);
    }
    get exists() {
      return fsState.files.has(this.uri);
    }
    create() {
      fsState.files.add(this.uri);
      fsState.createdDirs.push(this.uri);
    }
  }
  return {
    File: FakeFile,
    Directory: FakeDirectory,
    Paths: { cache: "cache", document: "file:///doc" },
  };
});

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
    extractModel: vi.fn(async () => ({ localPath: "/models/extracted" })),
    getStorageBasePath: vi.fn(async () => "/doc"),
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
  fsState.files.clear();
  fsState.copies.length = 0;
  fsState.downloads.length = 0;
  fsState.createdDirs.length = 0;
  fsState.deleted.length = 0;
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

describe("on-device speech model import", () => {
  const STT_ARCHIVE = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2";
  const TTS_ARCHIVE = "kokoro-int8-multi-lang-v1_1.tar.bz2";

  it("imports a picked STT archive to the fixed path and extracts it verified", async () => {
    await importOnDeviceSpeechModel("stt", `file:///picked/${STT_ARCHIVE}`, STT_ARCHIVE);
    expect(fsState.copies).toContainEqual({
      from: `file:///picked/${STT_ARCHIVE}`,
      to: `file:///doc/sherpa-onnx/models/stt/${STT_ARCHIVE}`,
    });
    expect(fake.native.refreshModels).toHaveBeenCalledWith("stt");
    expect(fake.native.extractModel).toHaveBeenCalledWith(
      "stt",
      expect.any(String),
      expect.objectContaining({ verifyChecksum: true }),
    );
  });

  it("imports a picked TTS archive without checksum verification", async () => {
    await importOnDeviceSpeechModel("tts", `file:///picked/${TTS_ARCHIVE}`, TTS_ARCHIVE);
    expect(fsState.copies).toContainEqual({
      from: `file:///picked/${TTS_ARCHIVE}`,
      to: `file:///doc/sherpa-onnx/models/tts/${TTS_ARCHIVE}`,
    });
    // The tts-models checksum.txt is stale upstream, so verification
    // would reject the official archive on every attempt.
    expect(fake.native.extractModel).toHaveBeenCalledWith(
      "tts",
      expect.any(String),
      expect.objectContaining({ verifyChecksum: false }),
    );
  });

  it("refuses a picked file with the wrong name", async () => {
    await expect(
      importOnDeviceSpeechModel("stt", `file:///picked/${TTS_ARCHIVE}`, TTS_ARCHIVE),
    ).rejects.toThrow(STT_ARCHIVE);
    expect(fsState.copies).toEqual([]);
    expect(fake.native.extractModel).not.toHaveBeenCalled();
  });

  it("downloads a model from a custom address and extracts it", async () => {
    await downloadOnDeviceSpeechModelFromAddress("tts", "https://example.com/models/");
    expect(fsState.downloads).toContainEqual({
      url: `https://example.com/models/${TTS_ARCHIVE}`,
      to: `file:///doc/sherpa-onnx/models/tts/${TTS_ARCHIVE}.tmp`,
    });
    expect(fsState.copies).toContainEqual({
      from: `file:///doc/sherpa-onnx/models/tts/${TTS_ARCHIVE}.tmp`,
      to: `file:///doc/sherpa-onnx/models/tts/${TTS_ARCHIVE}`,
    });
    expect(fake.native.extractModel).toHaveBeenCalledWith(
      "tts",
      expect.any(String),
      expect.objectContaining({ verifyChecksum: false }),
    );
  });

  it("refuses an empty custom address", async () => {
    await expect(downloadOnDeviceSpeechModelFromAddress("stt", "  ")).rejects.toThrow();
    expect(fsState.downloads).toEqual([]);
    expect(fake.native.extractModel).not.toHaveBeenCalled();
  });

  it("downloads only the missing models from a custom address", async () => {
    fake = fakeNative({ sttDownloaded: true, ttsDownloaded: false });
    setOnDeviceSpeechNative(fake.native);
    const seen: number[] = [];
    await downloadOnDeviceSpeechModelsFromAddress("https://example.com/models", (status) => {
      if (status.progress !== null) seen.push(status.progress);
    });
    expect(fake.native.extractModel).toHaveBeenCalledTimes(1);
    expect(fake.native.extractModel).toHaveBeenCalledWith(
      "tts",
      expect.any(String),
      expect.anything(),
    );
    expect(fsState.downloads).toHaveLength(1);
    expect(fsState.downloads[0]?.url).toBe(`https://example.com/models/${TTS_ARCHIVE}`);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("keeps one model download address per account and clears it when empty", async () => {
    expect(await loadOnDeviceSpeechModelBaseUrl()).toBe("");
    await saveOnDeviceSpeechModelBaseUrl("https://example.com/models");
    expect(await loadOnDeviceSpeechModelBaseUrl()).toBe("https://example.com/models");
    sessionUser.id = "user-2";
    expect(await loadOnDeviceSpeechModelBaseUrl()).toBe("");
    sessionUser.id = "user-1";
    expect(await loadOnDeviceSpeechModelBaseUrl()).toBe("https://example.com/models");
    await saveOnDeviceSpeechModelBaseUrl("   ");
    expect(await loadOnDeviceSpeechModelBaseUrl()).toBe("");
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
