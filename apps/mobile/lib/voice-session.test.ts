import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptDeletedSpaceFallback,
  saveApiBase,
  selectSpace,
  subscribeConfirmedSpaceSwitch,
} from "./api-server";
import { DEVICE_VOICE_KEY } from "./device-voice";
import { clearSessionToken, restoreSessionToken, saveSessionToken } from "./session";
import { getVoicePlaybackState, speakQueue } from "./voice";

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
  stop: vi.fn(async () => undefined),
  pause: vi.fn(),
  resume: vi.fn(),
  getAvailableVoicesAsync: vi.fn(async () => []),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn(), clearUnsentSends: vi.fn() }));

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

async function savedApiBase(input: string): Promise<string> {
  const result = await saveApiBase(input);
  if (!result.ok) throw new Error(result.error);
  return result.url;
}

describe("read-aloud across session changes", () => {
  let secureStore: Map<string, string>;

  beforeEach(async () => {
    secureStore = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(
      async (key: string) => secureStore.get(key) ?? null,
    );
    vi.mocked(SecureStore.setItemAsync).mockImplementation(
      async (key: string, value: string) => void secureStore.set(key, value),
    );
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(
      async (key: string) => void secureStore.delete(key),
    );
    await restoreSessionToken("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stops the on-device queue when the session is cleared", async () => {
    secureStore.set(DEVICE_VOICE_KEY, "1");
    await saveSessionToken("token-a");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
      { text: "Third reply.", botId: "bot-a", messageId: "m3" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-a" });

    await clearSessionToken();

    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    utterances[0]?.options?.onStopped?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply."]);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
  });

  it("stops the hosted queue without sending the queued replies to the next server", async () => {
    const serverA = await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    secureStore.set(DEVICE_VOICE_KEY, "0");
    ControllableAudio.instances = [];
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/rpc/aiConsent/status")) {
          return Response.json({ json: { version: "2026-09-14", recipients: [] } });
        }
        if (url.endsWith("/rpc/voice/prepare")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { json?: { text?: string } };
          return Response.json({
            json: { ready: true, utterances: [body.json?.text ?? ""] },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );
    vi.stubGlobal("Audio", ControllableAudio);

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(ControllableAudio.instances).toHaveLength(1));
    const audio = ControllableAudio.instances[0]!;
    await vi.waitFor(() => expect(audio.paused).toBe(false));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "m1" });

    const serverB = await savedApiBase("https://b.example.test");

    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    expect(audio.paused).toBe(true);
    expect(requests.filter((url) => url.startsWith(serverB))).toEqual([]);
    audio.onended?.();
    await expect(queued).resolves.toBe(true);
    expect(requests.filter((url) => url.endsWith("/api/voice/speak"))).toEqual([
      `${serverA}/api/voice/speak`,
    ]);
    expect(requests.filter((url) => url.startsWith(serverB))).toEqual([]);
  });

  it("stops the on-device queue when the selection moves to another Space", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    await selectSpace("space-a");
    secureStore.set(DEVICE_VOICE_KEY, "1");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-a" });

    await selectSpace("space-b");

    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    utterances[0]?.options?.onStopped?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply."]);
  });

  it("keeps the queue when the same Space is selected again", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    await selectSpace("space-a");
    secureStore.set(DEVICE_VOICE_KEY, "1");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "m1" });

    await selectSpace("space-a");

    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "m1" });
    utterances[0]?.options?.onDone?.();
    await vi.waitFor(() => expect(utterances).toHaveLength(2));
    utterances[1]?.options?.onDone?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply.", "Second reply."]);
  });

  it("stops the queue when a deleted organization's fallback adopts another Space", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    await selectSpace("space-a");
    secureStore.set(DEVICE_VOICE_KEY, "1");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-a" });

    const adopted = await adoptDeletedSpaceFallback("space-b");

    expect(adopted).toBe(true);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    utterances[0]?.options?.onStopped?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply."]);
  });

  it("notifies once when a failed adoption persists on retry", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    await selectSpace("space-a");
    secureStore.set(DEVICE_VOICE_KEY, "1");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });
    let notifications = 0;
    const unsubscribe = subscribeConfirmedSpaceSwitch(() => {
      notifications += 1;
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-a" });

    // The Space write, the clear's write fallback and the recovery record fail once.
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });
    vi.mocked(SecureStore.deleteItemAsync)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });
    const failed = await adoptDeletedSpaceFallback("space-b");

    expect(failed).toBe(false);
    expect(notifications).toBe(0);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-a" });

    const retried = await adoptDeletedSpaceFallback("space-b");
    unsubscribe();

    expect(retried).toBe(true);
    expect(notifications).toBe(1);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    utterances[0]?.options?.onStopped?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply."]);
  });

  it("lets a manual selection consume the pending origin, so a retry keeps its playback", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    await selectSpace("space-a");
    secureStore.set(DEVICE_VOICE_KEY, "1");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });
    let notifications = 0;
    const unsubscribe = subscribeConfirmedSpaceSwitch(() => {
      notifications += 1;
    });

    // The Space write, the clear's write fallback and the recovery record fail once.
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });
    vi.mocked(SecureStore.deleteItemAsync)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });
    const failed = await adoptDeletedSpaceFallback("space-b");
    expect(failed).toBe(false);
    expect(notifications).toBe(0);

    // The user opens B through Search; the confirmed selection consumes the origin.
    const opened = await selectSpace("space-b");
    expect(opened).toBe(true);
    expect(notifications).toBe(1);

    // Read-aloud starts in B.
    const queued = speakQueue([
      { text: "First reply.", botId: "bot-b", messageId: "m1" },
      { text: "Second reply.", botId: "bot-b", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-b" });

    // The inbox retry persists B; B's own playback continues.
    const retried = await adoptDeletedSpaceFallback("space-b");
    unsubscribe();

    expect(retried).toBe(true);
    expect(notifications).toBe(1);
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", botId: "bot-b" });
    utterances[0]?.options?.onDone?.();
    await vi.waitFor(() => expect(utterances).toHaveLength(2));
    utterances[1]?.options?.onDone?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply.", "Second reply."]);
  });

  it("stops the on-device queue when another account signs in", async () => {
    secureStore.set(DEVICE_VOICE_KEY, "1");
    await saveSessionToken("token-a");
    const utterances: Array<{ text: string; options: Parameters<typeof Speech.speak>[1] }> = [];
    vi.mocked(Speech.speak).mockImplementation((text, options) => {
      utterances.push({ text, options });
    });

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(utterances).toHaveLength(1));

    await saveSessionToken("token-b");

    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
    utterances[0]?.options?.onStopped?.();
    await expect(queued).resolves.toBe(true);
    expect(utterances.map((spoken) => spoken.text)).toEqual(["First reply."]);
  });

  it("keeps a late prepare failure silent after the session is cleared", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    secureStore.set(DEVICE_VOICE_KEY, "0");
    let failPrepare: ((status: number) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/rpc/aiConsent/status")) {
          return Response.json({ json: { version: "2026-09-14", recipients: [] } });
        }
        if (url.endsWith("/rpc/voice/prepare")) {
          return new Promise<Response>((resolve) => {
            failPrepare = (status: number) =>
              resolve(Response.json({ json: { message: "expired" } }, { status }));
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(failPrepare).toBeTypeOf("function"));
    expect(getVoicePlaybackState()).toMatchObject({ status: "playing", messageId: "m1" });

    await clearSessionToken();
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });

    failPrepare?.(401);
    await expect(queued).resolves.toBe(true);
  });

  it("keeps a late clip failure silent after the session is cleared", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    secureStore.set(DEVICE_VOICE_KEY, "0");
    let failClip: ((status: number) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/rpc/aiConsent/status")) {
          return Response.json({ json: { version: "2026-09-14", recipients: [] } });
        }
        if (url.endsWith("/rpc/voice/prepare")) {
          return Response.json({ json: { ready: true, utterances: ["First reply."] } });
        }
        return new Promise<Response>((resolve) => {
          failClip = (status: number) =>
            resolve(Response.json({ json: { message: "expired" } }, { status }));
        });
      }),
    );

    const queued = speakQueue([
      { text: "First reply.", botId: "bot-a", messageId: "m1" },
      { text: "Second reply.", botId: "bot-a", messageId: "m2" },
    ]);
    await vi.waitFor(() => expect(failClip).toBeTypeOf("function"));

    await clearSessionToken();
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });

    failClip?.(401);
    await expect(queued).resolves.toBe(true);
  });

  it("still reports a late prepare failure while the queue is current", async () => {
    await savedApiBase("https://a.example.test");
    await saveSessionToken("token-a");
    secureStore.set(DEVICE_VOICE_KEY, "0");
    let failPrepare: ((status: number) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/rpc/aiConsent/status")) {
          return Response.json({ json: { version: "2026-09-14", recipients: [] } });
        }
        if (url.endsWith("/rpc/voice/prepare")) {
          return new Promise<Response>((resolve) => {
            failPrepare = (status: number) =>
              resolve(Response.json({ json: { message: "expired" } }, { status }));
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    );

    const queued = speakQueue([{ text: "First reply.", botId: "bot-a", messageId: "m1" }]);
    await vi.waitFor(() => expect(failPrepare).toBeTypeOf("function"));

    failPrepare?.(401);
    await expect(queued).rejects.toBeInstanceOf(Error);
    expect(getVoicePlaybackState()).toEqual({ status: "idle", canPause: false });
  });
});
