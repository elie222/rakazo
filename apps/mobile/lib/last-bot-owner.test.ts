import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LastBot from "./last-bot";
import type * as Session from "./session";

const { saved, account } = vi.hoisted(() => ({
  saved: new Map<string, string>(),
  account: {
    apiBase: "https://app.example.test",
    userId: "account-a",
    available: true,
    selectedSpace: "space-a",
    ownerGate: null as Promise<void> | null,
    ownerCalls: 0,
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => saved.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    saved.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    saved.delete(key);
  }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => account.apiBase,
  selectedSpaceId: () => account.selectedSpace,
  captureApiRequestContext: async () => ({
    apiBase: account.apiBase,
    sessionGeneration: session.currentSessionGeneration(),
    headers: { authorization: `Bearer ${await session.loadSessionToken()}` },
  }),
  fetchMobileJson: async () => {
    account.ownerCalls += 1;
    await account.ownerGate;
    return {
      response: new Response(null, { status: account.available ? 200 : 401 }),
      body: { user: { id: account.userId } },
    };
  },
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));

let session: typeof Session;
let lastBot: typeof LastBot;
async function restart() {
  vi.resetModules();
  session = await import("./session");
  lastBot = await import("./last-bot");
  session.registerSessionDiskCache((sameAccount) => {
    if (!sameAccount) return lastBot.clearLastBot();
  });
}

beforeEach(async () => {
  saved.clear();
  account.apiBase = "https://app.example.test";
  account.userId = "account-a";
  account.available = true;
  account.selectedSpace = "space-a";
  account.ownerGate = null;
  account.ownerCalls = 0;
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    saved.delete(key);
  });
  await restart();
  await session.saveSessionToken("session-a");
});
afterEach(() => vi.useRealTimers());

const record = {
  botId: "researcher",
  spaceId: "space-a",
  apiBase: "https://app.example.test",
  userId: "account-a",
};

describe("last bot ownership", () => {
  it.each([
    ["legacy id", "researcher"],
    ["missing owner", JSON.stringify({ botId: "researcher" })],
    ["missing server", JSON.stringify({ botId: "researcher", userId: "account-a" })],
    ["other account", JSON.stringify({ ...record, userId: "account-b" })],
    ["other server", JSON.stringify({ ...record, apiBase: "https://other.example.test" })],
  ])("ignores a stored %s", async (_name, stored) => {
    saved.set("rakazo.last_bot_id", stored);
    expect(await lastBot.loadLastBotId()).toBe("");
  });

  it("reads a matching owner from disk on a cold start", async () => {
    saved.set("rakazo.last_bot_id", JSON.stringify(record));
    await restart();
    expect(await lastBot.loadLastBotId()).toBe("researcher");
  });

  it("ignores a stored target when the current account cannot be verified", async () => {
    await lastBot.saveLastBotId("researcher", "space-a");
    account.available = false;
    expect(await lastBot.loadLastBotId()).toBe("");
  });

  it("ignores a stored target saved in another Space until that Space opens again", async () => {
    await lastBot.saveLastBotId("researcher", "space-a");
    account.selectedSpace = "space-b";
    expect(await lastBot.loadLastBotId()).toBe("");
    account.selectedSpace = "space-a";
    expect(await lastBot.loadLastBotId()).toBe("researcher");
  });

  it("drops the target when the selected Space changes during owner verification", async () => {
    await lastBot.saveLastBotId("researcher", "space-a");
    const savedWhileWaiting = account.ownerCalls;

    let release!: () => void;
    account.ownerGate = new Promise<void>((done) => {
      release = done;
    });
    const switched = lastBot.loadLastBotId();
    await vi.waitFor(() => expect(account.ownerCalls).toBe(savedWhileWaiting + 1));
    account.selectedSpace = "space-b";
    release();
    await expect(switched).resolves.toBe("");

    account.selectedSpace = "space-a";
    let resolveReturn!: () => void;
    account.ownerGate = new Promise<void>((done) => {
      resolveReturn = done;
    });
    const returned = lastBot.loadLastBotId();
    await vi.waitFor(() => expect(account.ownerCalls).toBe(savedWhileWaiting + 2));
    account.selectedSpace = "space-b";
    account.selectedSpace = "space-a";
    resolveReturn();
    await expect(returned).resolves.toBe("researcher");
  });

  it.each(["account", "server"])(
    "does not recover the old target after a stalled cleanup and %s change",
    async (change) => {
      await lastBot.saveLastBotId("researcher", "space-a");
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (key === "rakazo.last_bot_id") await new Promise<void>(() => {});
        else saved.delete(key);
      });
      if (change === "account") account.userId = "account-b";
      else account.apiBase = "https://other.example.test";
      await session.saveSessionToken("session-b");
      expect(saved.get("rakazo.session_token")).toBe("session-b");
      expect(saved.has("rakazo.last_bot_id")).toBe(true);
      vi.useFakeTimers();
      const loaded = vi.fn();
      void lastBot.loadLastBotId().then(loaded);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(loaded).toHaveBeenCalledExactlyOnceWith("");
      vi.useRealTimers();
      await restart();
      expect(await lastBot.loadLastBotId()).toBe("");
    },
  );
});
