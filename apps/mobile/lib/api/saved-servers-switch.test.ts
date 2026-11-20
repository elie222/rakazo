vi.mock("../settings/ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentApiBase } from "./api.js";
import { loadApiBase, resetApiBase, saveApiBase } from "./api-server.js";
import { defaultApiBase } from "./endpoint.js";
import { loadSavedServers, savedServers } from "./saved-servers.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../notifications/live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

const ONE = "https://one.example.test";
const TWO = "https://two.example.test";
const ACCESS = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };
const SAVED_KEY = "rakazo.saved_servers";

let store: Map<string, string>;

function listed() {
  return savedServers().map((entry) => entry.apiBase);
}

beforeEach(async () => {
  store = new Map();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  await resetApiBase();
  store.clear();
  await loadSavedServers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saved servers across a server switch", () => {
  it("remembers the server it moved to and the default server it left is not listed", async () => {
    await expect(saveApiBase(ONE, ACCESS)).resolves.toEqual({ ok: true, url: ONE });
    expect(savedServers()).toEqual([{ apiBase: ONE, headers: ACCESS }]);
  });

  it("lists the server it left, with its headers, so it can be returned to", async () => {
    await saveApiBase(ONE, ACCESS);
    await saveApiBase(TWO, {});
    expect(savedServers()).toEqual([
      { apiBase: TWO, headers: {} },
      { apiBase: ONE, headers: ACCESS },
    ]);
    await resetApiBase();
    expect(listed()).toEqual([TWO, ONE]);
  });

  it("keeps a server set up before the list existed when it is left for the default", async () => {
    store.set("rakazo.api_base", ONE);
    store.set("rakazo.server_headers", JSON.stringify({ apiBase: ONE, headers: ACCESS }));
    await loadApiBase();
    expect(currentApiBase()).toBe(ONE);
    expect(savedServers()).toEqual([]);
    await resetApiBase();
    expect(savedServers()).toEqual([{ apiBase: ONE, headers: ACCESS }]);
  });

  it("saving the same server again updates its headers without a duplicate", async () => {
    await saveApiBase(ONE, {});
    await saveApiBase(ONE, ACCESS);
    expect(savedServers()).toEqual([{ apiBase: ONE, headers: ACCESS }]);
  });

  it("lists nothing for the default server, with or without headers", async () => {
    await saveApiBase(defaultApiBase(), {});
    expect(savedServers()).toEqual([]);
    await saveApiBase(defaultApiBase(), ACCESS);
    expect(savedServers()).toEqual([]);
    expect(store.has(SAVED_KEY)).toBe(false);
  });

  it("lists nothing when the switch fails", async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    await expect(saveApiBase(ONE, ACCESS)).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(defaultApiBase());
    expect(savedServers()).toEqual([]);
    expect(store.has(SAVED_KEY)).toBe(false);
  });

  it("does not fail a committed switch when the list cannot be written", async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === SAVED_KEY) throw new Error("device locked");
      store.set(key, value);
    });
    await expect(saveApiBase(ONE, ACCESS)).resolves.toEqual({ ok: true, url: ONE });
    expect(currentApiBase()).toBe(ONE);
    expect(savedServers()).toEqual([]);
    await expect(resetApiBase()).resolves.toEqual({ ok: true, url: defaultApiBase() });
    expect(currentApiBase()).toBe(defaultApiBase());
  });

  it("loads the list at launch next to the server it belongs to", async () => {
    await saveApiBase(ONE, ACCESS);
    await saveApiBase(TWO, {});
    await loadSavedServers();
    store.set("rakazo.api_base", TWO);
    await loadApiBase();
    expect(listed()).toEqual([TWO, ONE]);
  });

  it("leaving a server whose headers did not load keeps the headers it was saved with", async () => {
    await saveApiBase(ONE, ACCESS);
    // The headers value is damaged at launch, so the app holds none for the server it is on.
    store.set("rakazo.server_headers", "damaged");
    await loadApiBase();
    expect(currentApiBase()).toBe(ONE);
    await resetApiBase();
    expect(savedServers()).toEqual([{ apiBase: ONE, headers: ACCESS }]);
  });
});
