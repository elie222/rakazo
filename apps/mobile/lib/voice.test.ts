import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import {
  MAX_VOICE_AUDIO_BYTES,
  playMpeg,
  speakText,
  speakUtterance,
  VOICE_RESPONSE_TIMEOUT_MS,
} from "./voice";

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
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
    vi.mocked(captureApiRequestContext).mockResolvedValue({
      apiBase: "https://support.example",
      headers: {
        authorization: "Bearer support-token",
        "x-rakazo-space-id": "space-support",
      },
    });
    vi.mocked(rpc).mockImplementation(async () => {
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
