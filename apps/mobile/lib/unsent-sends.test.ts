import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { router } from "expo-router";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendAttempt } from "./thread-feedback";
import { configureUnsentSends, hasUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { startUnsentSends } from "./unsent-sends";

const session = vi.hoisted(() => ({ generation: 1, ready: 1, listener: () => {} }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://api.example.test",
  isServerReachable: vi.fn(),
  passwordChangeInFlight: () => false,
  selectedSpaceId: () => "space-a",
  subscribeServerReachable: () => () => {},
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => "ns-a" }));
vi.mock("./integrations-cache", () => ({}));
vi.mock("./outbox-disk", () => ({ outboxDisk: {} }));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => session.ready,
  currentSessionGeneration: () => session.generation,
  loadSessionToken: async () => "fake-token",
  loadVerifiedIntegrationsScope: async () => ({
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  }),
  subscribeSessionGeneration: (listener: () => void) => {
    session.listener = listener;
    return () => {};
  },
}));
vi.mock("./thread-feedback", () => ({
  configureUnsentSends: vi.fn(),
  hasUnsentSends: vi.fn(),
  restoreUnsentSends: vi.fn(),
  sendWaitingMessages: vi.fn(async () => undefined),
}));
vi.mock("./i18n", () => ({ t: (message: string) => `translated: ${message}` }));

const { notDelivered } = vi.mocked(configureUnsentSends).mock.calls[0]![0];
function attempt(error: string): SendAttempt {
  return { error } as SendAttempt;
}
beforeEach(() => vi.clearAllMocks());
describe("notDelivered", () => {
  it("leaves image confirmation to the contextual choices without a generic modal", () => {
    notDelivered({
      ...attempt("Image input is not configured for this model."),
      imageConfirmation: true,
    });
    expect(Alert.alert).not.toHaveBeenCalled();
  });
  it("offers Models settings and cancellation for the missing-model rejection", () => {
    notDelivered(attempt(` ${MODEL_REQUIRED_SEND_ERROR} `));
    const [title, message, buttons] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(title).toBe("translated: Add an AI model to keep chatting");
    expect(message).toBeUndefined();
    expect(buttons).toEqual([
      { text: "translated: Not Now", style: "cancel" },
      { text: "translated: Add Model", onPress: expect.any(Function), isPreferred: true },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    buttons![1]!.onPress!();
    expect(router.push).toHaveBeenCalledWith("/(settings)/models");
  });
  it("keeps the existing alert for unrelated errors", () => {
    notDelivered(attempt("Rejected"));
    expect(Alert.alert).toHaveBeenCalledWith("translated: Failed to send message", "Rejected");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("startUnsentSends", () => {
  it("sends the queue a password change kept once the new session is ready", async () => {
    const stop = startUnsentSends();
    await vi.waitFor(() => expect(sendWaitingMessages).toHaveBeenCalledOnce());
    vi.mocked(hasUnsentSends).mockReturnValue(true);
    session.generation = 2;
    session.listener();
    session.ready = 2;
    session.listener();
    await vi.waitFor(() => expect(sendWaitingMessages).toHaveBeenCalledTimes(2));
    // Every other session change empties the queue first.
    vi.mocked(hasUnsentSends).mockReturnValue(false);
    session.generation = session.ready = 3;
    session.listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendWaitingMessages).toHaveBeenCalledTimes(2);
    stop();
  });
});
