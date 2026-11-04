import { setImmediate } from "node:timers/promises";
import * as SecureStore from "expo-secure-store";
import { openAuthSessionAsync } from "expo-web-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMobileJson } from "./api";
import { clearLastBot, loadLastBotId, saveLastBotId } from "./last-bot";
import {
  clearSessionToken,
  currentSessionGeneration,
  registerSessionDiskCache,
  restoreSessionToken,
  rotateSessionTokenIfCurrent,
  saveSessionToken,
} from "./session";
import { continueWithSso } from "./sso";

const { saved } = vi.hoisted(() => ({ saved: new Map<string, string>() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => saved.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    saved.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    saved.delete(key);
  }),
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./api", () => ({
  authHeaders: async () => ({ authorization: "Bearer session-a" }),
  clearSpace: async () => true,
  currentApiBase: () => "https://app.example.test",
  fetchMobileJson: vi.fn(),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));

registerSessionDiskCache((sameAccount?: boolean) => {
  if (!sameAccount) return clearLastBot();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("last bot shortcut target", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await saveSessionToken("session-a");
    saved.clear();
  });

  it("does not carry an explicit Space into a later default-Space chat", async () => {
    await saveLastBotId("researcher", "shared-space");
    expect(await loadLastBotId()).toBe("researcher");
    expect(saved.get("rakazo.last_bot_space_id")).toBe("shared-space");

    await saveLastBotId("writer", null);
    expect(await loadLastBotId()).toBe("writer");
    expect(saved.has("rakazo.last_bot_space_id")).toBe(false);
  });

  it.each(["sign-in", "sign-out", "server"])("clears the last bot on %s", async (change) => {
    await saveLastBotId("researcher", "shared-space");
    if (change === "sign-in") await saveSessionToken("other-account-session");
    else if (change === "sign-out") await clearSessionToken();
    else await restoreSessionToken("other-server-session");
    expect(await loadLastBotId()).toBe("");
    expect(saved.has("rakazo.last_bot_space_id")).toBe(false);
  });

  it("keeps the last bot and Space during same-account password token rotation", async () => {
    await saveLastBotId("researcher", "shared-space");
    await rotateSessionTokenIfCurrent(currentSessionGeneration(), "session-a", "rotated-session");
    expect(await loadLastBotId()).toBe("researcher");
    expect(saved.get("rakazo.last_bot_space_id")).toBe("shared-space");
  });

  it("keeps the last bot and Space after verified SSO re-authentication", async () => {
    await saveLastBotId("researcher", "shared-space");
    vi.mocked(fetchMobileJson)
      .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "account-a" } } })
      .mockResolvedValueOnce({
        response: Response.json({}),
        body: { url: "https://identity.example.test/authorize?state=test-state" },
      })
      .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "account-a" } } });
    vi.mocked(openAuthSessionAsync).mockResolvedValue({
      type: "success",
      url: `rakazo://account?cookie=${encodeURIComponent("better-auth.session_token=reauthed-session; Path=/; HttpOnly")}`,
    });
    expect(await continueWithSso("reauthenticate")).toBe(true);
    expect(await loadLastBotId()).toBe("researcher");
    expect(saved.get("rakazo.last_bot_space_id")).toBe("shared-space");
  });

  it("clears a delayed old-session write and drops other saves queued by that session", async () => {
    const started = deferred();
    const release = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      started.resolve();
      await release.promise;
      saved.set(key, value);
    });
    const writing = saveLastBotId("researcher", "space-a");
    await started.promise;
    const obsolete = saveLastBotId("obsolete", "space-a");
    const changing = saveSessionToken("session-b");
    release.resolve();
    await Promise.all([writing, obsolete, changing]);
    expect(await loadLastBotId()).toBe("");
    expect(saved.has("rakazo.last_bot_space_id")).toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.last_bot_id", "obsolete");
    await saveLastBotId("writer", "space-b");
    expect(await loadLastBotId()).toBe("writer");
    expect(saved.get("rakazo.last_bot_space_id")).toBe("space-b");
  });

  it("waits for a pending delete before exposing a target to the new session", async () => {
    await saveLastBotId("researcher", "space-a");
    const started = deferred();
    const release = deferred();
    const remove = vi.mocked(SecureStore.deleteItemAsync).getMockImplementation()!;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.last_bot_id") {
        started.resolve();
        await release.promise;
      }
      await remove(key);
    });
    try {
      const changing = saveSessionToken("session-b");
      await started.promise;
      const read = loadLastBotId();
      const readFinished = vi.fn();
      void read.then(readFinished);
      await setImmediate();
      const finishedBeforeDelete = readFinished.mock.calls.length > 0;
      release.resolve();
      await changing;
      expect(await read).toBe("");
      expect(finishedBeforeDelete).toBe(false);
    } finally {
      release.resolve();
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(remove);
    }
  });
});
