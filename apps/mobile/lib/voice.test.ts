import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import { speakText } from "./voice";

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
});
