import { resolveComposerSendPlan } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { expect, it, vi } from "vitest";
import { artifactCacheSession, rotateArtifactCacheSession } from "./artifact-cache-session";
import type { SendAttempt } from "./thread-feedback";
import { hasUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { prepareUnsentSends } from "./unsent-sends";

const state = vi.hoisted(() => ({
  token: "fake-a",
  generation: 1,
  keychain: new Map<string, string>(),
  saved: [] as SendAttempt[],
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => state.keychain.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.keychain.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    state.keychain.delete(key);
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ headers: {} }),
  currentApiBase: () => "https://api.example.test",
  isServerReachable: () => true,
  passwordChangeInFlight: () => false,
  rpc: vi.fn(async () => ({ seq: 7 })),
  selectedSpaceId: () => "space-a",
  subscribeServerReachable: () => () => {},
}));
vi.mock("./integrations-cache", () => ({}));
vi.mock("./outbox-disk", () => ({
  outboxDisk: {
    admit: () => true,
    hydrate: async () => undefined,
    forget: () => undefined,
    load: () => state.saved,
    save: () => undefined,
    clear: () => undefined,
  },
}));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => state.generation,
  currentSessionGeneration: () => state.generation,
  loadSessionToken: async () => state.token,
  loadVerifiedIntegrationsScope: async () => ({
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  }),
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./i18n", () => ({ t: (message: string) => message }));

it("keeps a password change's unsent messages retryable when a namespace rewrite fails", async () => {
  const rpc = vi.mocked((await import("./api")).rpc);
  state.saved = [
    {
      payload: {
        originThreadKey: "bot-1",
        displayText: "Hello",
        replyPreview: null,
        botTarget: "bot-1",
        reroutedToGroup: false,
        plan: resolveComposerSendPlan({ text: "Hello", mentions: [], hasAttachments: false }),
        attachments: [],
        replyQuote: null,
      },
      clientNonce: "nonce-1",
      artifactIds: new Map(),
      state: "queued",
      apiBase: "https://api.example.test",
      spaceId: "space-a",
      userId: "user-a",
      cacheSession: await artifactCacheSession("fake-a"),
      session: 0,
    },
  ];
  await prepareUnsentSends();

  await rotateArtifactCacheSession("fake-a", "fake-b");
  state.token = "fake-b";
  state.generation = 2;
  vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
  await prepareUnsentSends();

  await sendWaitingMessages(true);
  expect(rpc).toHaveBeenCalledWith(
    "threads/send",
    expect.objectContaining({ clientNonce: "nonce-1" }),
    expect.anything(),
  );
  expect(hasUnsentSends()).toBe(false);
});
