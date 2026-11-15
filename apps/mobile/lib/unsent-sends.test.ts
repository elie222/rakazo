import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { router } from "expo-router";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasSavedUnsentSends } from "./outbox-disk";
import { loadVerifiedIntegrationsScope, snapshotSessionToken } from "./session";
import type { SendAttempt } from "./thread-feedback";
import {
  configureUnsentSends,
  hasUnsentSends,
  restoreUnsentSends,
  sendWaitingMessages,
  unsentSendsReadable,
} from "./thread-feedback";
import { prepareUnsentSends, startUnsentSends, unsentSendsRestored } from "./unsent-sends";

const session = vi.hoisted(() => ({ generation: 1, ready: 1, listener: () => {} }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://api.example.test",
  isServerReachable: vi.fn(),
  passwordChangeInFlight: () => false,
  selectedSpaceId: () => "space-a",
  subscribeServerReachable: () => () => {},
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => "ns-a" }));
vi.mock("./integrations-cache", () => ({}));
vi.mock("./outbox-disk", () => ({ outboxDisk: {}, hasSavedUnsentSends: vi.fn(() => false) }));
vi.mock("./session", () => ({
  currentReadySessionGeneration: () => session.ready,
  currentSessionGeneration: () => session.generation,
  loadSessionToken: async () => "fake-token",
  loadVerifiedIntegrationsScope: vi.fn(async () => ({
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  })),
  snapshotSessionToken: vi.fn(async () => ({ ok: true, value: "fake-token" })),
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
  unsentSendsReadable: vi.fn(() => true),
}));

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
    expect(title).toBe("Add an AI model to keep chatting");
    expect(message).toBeUndefined();
    expect(buttons).toEqual([
      { text: "Not Now", style: "cancel" },
      { text: "Add model", onPress: expect.any(Function), isPreferred: true },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    buttons![1]!.onPress!();
    expect(router.push).toHaveBeenCalledWith("/(settings)/models");
  });
  it("keeps the existing alert for unrelated errors", () => {
    notDelivered(attempt("Rejected"));
    expect(Alert.alert).toHaveBeenCalledWith("Failed to send message", "Rejected");
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

  it("restores again after a sign-in, so a signed-out launch's failure does not linger", async () => {
    session.generation = session.ready = 40;
    vi.mocked(hasUnsentSends).mockReturnValue(false);
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("signed out"));
    const stop = startUnsentSends();
    await vi.waitFor(() => expect(loadVerifiedIntegrationsScope).toHaveBeenCalled());
    await expect(unsentSendsRestored()).resolves.toBe(false);
    // Sign-in: the new session cleared the queue and is ready.
    session.generation = session.ready = 41;
    session.listener();
    await expect(unsentSendsRestored()).resolves.toBe(true);
    stop();
  });
});

describe("unsentSendsRestored", () => {
  it("resolves only after the disk queue is restored", async () => {
    session.generation = 20;
    let unblockRestore!: () => void;
    vi.mocked(loadVerifiedIntegrationsScope).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          unblockRestore = () =>
            resolve({
              apiBase: "https://api.example.test",
              userId: "user-a",
              spaceId: "space-a",
              selectionId: "space-a",
            });
        }),
    );
    void prepareUnsentSends();
    let settled = false;
    const restored = unsentSendsRestored().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(restoreUnsentSends).not.toHaveBeenCalled();

    unblockRestore();
    await restored;
    expect(restoreUnsentSends).toHaveBeenCalledOnce();
    await expect(unsentSendsRestored()).resolves.toBe(true);
  });

  it("reports an unknown queue when a signed-in restore fails", async () => {
    session.generation = 21;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("store unreadable"));
    await expect(prepareUnsentSends()).rejects.toThrow("store unreadable");
    await expect(unsentSendsRestored()).resolves.toBe(false);
  });

  it("reports an unknown queue when the saved queue could not be read", async () => {
    session.generation = 25;
    vi.mocked(unsentSendsReadable).mockReturnValueOnce(false);
    await prepareUnsentSends();
    await expect(unsentSendsRestored()).resolves.toBe(false);
  });

  it("treats an unread queue as known once clearing the session made it readable", async () => {
    session.generation = 26;
    vi.mocked(unsentSendsReadable).mockReturnValueOnce(false);
    await prepareUnsentSends();
    await expect(unsentSendsRestored()).resolves.toBe(false);
    // Sign-out cleared the queue; no new restore runs before a server switch asks again.
    await expect(unsentSendsRestored()).resolves.toBe(true);
  });

  it("treats a failed restore as known once the session is gone", async () => {
    session.generation = 27;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("store unreadable"));
    await expect(prepareUnsentSends()).rejects.toThrow("store unreadable");
    await expect(unsentSendsRestored()).resolves.toBe(false);
    vi.mocked(snapshotSessionToken).mockResolvedValueOnce({ ok: true, value: "" });
    await expect(unsentSendsRestored()).resolves.toBe(true);
  });

  it("follows a restore that starts while the session is read", async () => {
    session.generation = 28;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("store unreadable"));
    await expect(prepareUnsentSends()).rejects.toThrow("store unreadable");
    let readSession!: (value: { ok: true; value: string }) => void;
    vi.mocked(snapshotSessionToken).mockReturnValueOnce(
      new Promise((resolve) => {
        readSession = resolve;
      }),
    );
    const restored = unsentSendsRestored();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A reachability retry restores the queue while the session is still being read.
    await prepareUnsentSends();
    readSession({ ok: true, value: "fake-token" });
    await expect(restored).resolves.toBe(true);
  });

  it("treats a failed restore while signed out as an empty queue", async () => {
    session.generation = 22;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("signed out"));
    vi.mocked(snapshotSessionToken).mockResolvedValueOnce({ ok: true, value: "" });
    await expect(prepareUnsentSends()).rejects.toThrow("signed out");
    await expect(unsentSendsRestored()).resolves.toBe(true);
  });

  it("reports an unknown queue when signed out with messages a rejected session left on disk", async () => {
    session.generation = 29;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("signed out"));
    vi.mocked(snapshotSessionToken).mockResolvedValueOnce({ ok: true, value: "" });
    vi.mocked(hasSavedUnsentSends).mockReturnValueOnce(true);
    await expect(prepareUnsentSends()).rejects.toThrow("signed out");
    await expect(unsentSendsRestored()).resolves.toBe(false);
  });

  it("reports an unknown queue when signed out and the saved queue cannot be read", async () => {
    session.generation = 30;
    vi.mocked(loadVerifiedIntegrationsScope).mockRejectedValueOnce(new Error("signed out"));
    vi.mocked(snapshotSessionToken).mockResolvedValueOnce({ ok: true, value: "" });
    vi.mocked(hasSavedUnsentSends).mockImplementationOnce(() => {
      throw new Error("OUTBOX_STORAGE_UNAVAILABLE");
    });
    await expect(prepareUnsentSends()).rejects.toThrow("signed out");
    await expect(unsentSendsRestored()).resolves.toBe(false);
  });

  it("follows a restore that replaces the awaited one", async () => {
    session.generation = 23;
    const scopeA = deferred();
    const scopeB = deferred();
    vi.mocked(loadVerifiedIntegrationsScope)
      .mockImplementationOnce(() => scopeA.promise)
      .mockImplementationOnce(() => scopeB.promise);
    const first = prepareUnsentSends().catch(() => undefined);
    let settled = false;
    const restored = unsentSendsRestored().then((value) => {
      settled = true;
      return value;
    });
    // A newer session supersedes the first attempt, which then fails its generation check.
    session.generation = 24;
    void prepareUnsentSends();
    scopeA.resolve();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    scopeB.resolve();
    await expect(restored).resolves.toBe(true);
    expect(restoreUnsentSends).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<{
    apiBase: string;
    userId: string;
    spaceId: string;
    selectionId: string;
  }>((done) => {
    resolve = () =>
      done({
        apiBase: "https://api.example.test",
        userId: "user-a",
        spaceId: "space-a",
        selectionId: "space-a",
      });
  });
  return { promise, resolve };
}
