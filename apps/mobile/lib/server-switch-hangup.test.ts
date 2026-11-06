import { afterEach, expect, it, vi } from "vitest";

vi.mock("./haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
// Dictation reads the platform; the rest of react-native stays unloaded.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
// The real call module's native-backed imports, stubbed so it can load beside the real API.
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
  Paths: {},
}));
vi.mock("./call-sounds", () => ({
  playCallCue: vi.fn(),
  preloadWaitSound: vi.fn(),
  releaseWaitSound: vi.fn(),
  startWaitSound: vi.fn(),
  stopWaitSound: vi.fn(),
}));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("SpeechOwner"),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));

import { resetApiBase, saveApiBase } from "./api";
import type { CallDeps } from "./call-session";
import { startCall } from "./call-session";
import { currentSessionGeneration, saveSessionToken } from "./session";

/** Every part of a call except the ones that reach the server: those stay production code. */
const idleDeps: Partial<CallDeps> = {
  cue: async () => undefined,
  waitSound: () => undefined,
  dictate: async () => false,
  record: () => new Promise(() => undefined),
  speak: () => new Promise(() => undefined),
  stopSpeaking: () => undefined,
  watch: () => () => undefined,
};

const requests: Array<{ url: string; headers: Headers }> = [];

afterEach(() => {
  requests.length = 0;
  vi.unstubAllGlobals();
});

it.each([
  ["a server change", () => saveApiBase("https://second-server.example")],
  ["a reset to the default server", () => resetApiBase()],
])("hangs up on the old server before %s clears its session", async (_name, change) => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ json: {} }), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchImpl);
  const first = "https://first-server.example";
  await saveApiBase(first);
  await saveSessionToken("token-a");
  startCall(
    {
      botId: "bot-1",
      botName: "Ada",
      requestContext: {
        apiBase: first,
        headers: { authorization: "Bearer token-a" },
        sessionGeneration: currentSessionGeneration(),
      },
    },
    idleDeps,
  );
  await expect(change()).resolves.toMatchObject({ ok: true });
  const hangUp = requests.find((request) => request.url === `${first}/rpc/threads/endCall`);
  expect(hangUp).toBeDefined();
  expect(hangUp?.headers.get("authorization")).toBe("Bearer token-a");
});
