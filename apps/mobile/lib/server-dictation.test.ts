import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishServerDictation,
  listenServerDictation,
  serverTranscribeAvailable,
  setAudioModule,
  stopServerDictation,
} from "./server-dictation";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.example",
    headers: { authorization: "Bearer test" },
  })),
}));
vi.mock("./server-headers", () => ({
  fetchServer: vi.fn(),
}));
vi.mock("./call-session", () => ({
  SPEECH_LEVEL_DB: -35,
  SILENCE_HANG_MS: 1_200,
  METER_POLL_MS: 200,
  METER_START_MS: 1_000,
  MAX_CLIP_MS: 30_000,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    async base64() {
      return "AAAA";
    }
    delete() {}
  },
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
  voiceAccountErrorText: () => undefined,
}));

import { rpc } from "./api";
import { fetchServer } from "./server-headers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const audio = vi.hoisted(() => ({
  permission: { granted: true },
  metering: [] as (number | undefined)[],
  uri: "file:///clip.m4a" as string | null,
  record: vi.fn(),
  release: vi.fn(),
  setAudioMode: vi.fn(),
  stopped: false,
}));

function fakeAudioModule() {
  return {
    AudioModule: {
      requestRecordingPermissionsAsync: async () => audio.permission,
      AudioRecorder: class {
        uri = audio.uri;
        prepareToRecordAsync = async () => undefined;
        record = audio.record;
        stop = async () => {
          audio.stopped = true;
        };
        release = audio.release;
        getStatus = () => ({ metering: audio.metering.shift() });
      },
    },
    RecordingPresets: { HIGH_QUALITY: {} },
    setAudioModeAsync: async (mode: unknown) => audio.setAudioMode(mode),
  };
}

describe("server dictation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(rpc).mockReset();
    vi.mocked(fetchServer).mockReset();
    vi.mocked(fetchServer).mockResolvedValue(jsonResponse({ text: "你好" }));
    audio.permission = { granted: true };
    audio.metering = [];
    audio.uri = "file:///clip.m4a";
    audio.stopped = false;
    audio.record.mockClear();
    audio.release.mockClear();
    audio.setAudioMode.mockClear();
    setAudioModule(fakeAudioModule() as never);
  });

  it("reports the voice provider's transcribe capability", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ready: true, transcribe: true } as never);
    await expect(serverTranscribeAvailable()).resolves.toBe(true);
    vi.mocked(rpc).mockResolvedValueOnce({ ready: true, transcribe: false } as never);
    await expect(serverTranscribeAvailable()).resolves.toBe(false);
    vi.mocked(rpc).mockRejectedValueOnce(new Error("down"));
    await expect(serverTranscribeAvailable()).resolves.toBe(false);
  });

  it("records speech, then transcribes the clip on the server", async () => {
    audio.metering = [-20, -20, -50, -50, -50, -50, -50, -50];
    const finished = new Promise<string>((resolve) => {
      void listenServerDictation({
        onFinal: (text) => resolve(text),
        onGiveUp: (reason) => resolve(`gave-up:${reason}`),
      });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await finished).toBe("你好");
    expect(audio.record).toHaveBeenCalledOnce();
    expect(audio.stopped).toBe(true);
    expect(fetchServer).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchServer).mock.calls[0]!;
    expect(url).toBe("https://api.example/api/voice/transcribe");
    expect(JSON.parse(String(init?.body))).toEqual({
      audioBase64: "AAAA",
      mimeType: "audio/m4a",
    });
  });

  it("gives up idle when nothing was heard, without transcribing", async () => {
    audio.metering = [-50, -50, -50, -50, -50, -50, -50];
    const finished = new Promise<string>((resolve) => {
      void listenServerDictation({
        onFinal: (text) => resolve(text),
        onGiveUp: (reason) => resolve(`gave-up:${reason}`),
      });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await finished).toBe("gave-up:idle");
    expect(fetchServer).not.toHaveBeenCalled();
  });

  it("finishing early transcribes what was heard so far", async () => {
    audio.metering = [-20, -20, -20, -20, -20, -20, -20, -20];
    const finished = new Promise<string>((resolve) => {
      void listenServerDictation({
        onFinal: (text) => resolve(text),
        onGiveUp: (reason) => resolve(`gave-up:${reason}`),
      });
    });
    await vi.advanceTimersByTimeAsync(500);
    finishServerDictation();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await finished).toBe("你好");
    expect(fetchServer).toHaveBeenCalledOnce();
  });

  it("stopping discards the clip without a callback", async () => {
    audio.metering = [-20, -20, -20, -20, -20, -20, -20, -20];
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listenServerDictation({ onFinal, onGiveUp });
    await vi.advanceTimersByTimeAsync(500);
    stopServerDictation();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFinal).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(fetchServer).not.toHaveBeenCalled();
  });

  it("gives up failed when microphone permission is denied", async () => {
    audio.permission = { granted: false };
    const finished = new Promise<string>((resolve) => {
      void listenServerDictation({
        onFinal: (text) => resolve(text),
        onGiveUp: (reason) => resolve(`gave-up:${reason}`),
      });
    });
    await finished;
    expect(await finished).toBe("gave-up:failed");
    expect(audio.record).not.toHaveBeenCalled();
  });

  it("gives up failed when transcription fails", async () => {
    audio.metering = [-20, -20, -50, -50, -50, -50, -50, -50];
    vi.mocked(fetchServer).mockResolvedValueOnce(jsonResponse({ error: "no voice provider" }, 400));
    const finished = new Promise<string>((resolve) => {
      void listenServerDictation({
        onFinal: (text) => resolve(text),
        onGiveUp: (reason) => resolve(`gave-up:${reason}`),
      });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await finished).toBe("gave-up:failed");
  });
});
