import { deferred, flush } from "@rakazo/core/test-async";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApiBase } from "./endpoint";
import {
  loadSavedServers,
  MAX_SAVED_SERVERS,
  recordSavedServer,
  removeSavedServer,
  savedServers,
} from "./saved-servers";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const KEY = "rakazo.saved_servers";
const ONE = "https://one.example.test";
const TWO = "https://two.example.test";
const ACCESS = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };

let store: Map<string, string>;

beforeEach(async () => {
  vi.resetAllMocks();
  store = new Map();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
  await loadSavedServers();
});

describe("saved servers", () => {
  it("lists the most recent server first and keeps one entry per address", async () => {
    await recordSavedServer(ONE, {});
    await recordSavedServer(TWO, ACCESS);
    await recordSavedServer(ONE, ACCESS);
    expect(savedServers()).toEqual([
      { apiBase: ONE, headers: ACCESS },
      { apiBase: TWO, headers: ACCESS },
    ]);
    await loadSavedServers();
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([ONE, TWO]);
  });

  it("never lists the default server", async () => {
    expect(await recordSavedServer(defaultApiBase(), {})).toBe(false);
    expect(savedServers()).toEqual([]);
    expect(store.has(KEY)).toBe(false);
  });

  it("drops the oldest entry past the limit", async () => {
    for (let index = 0; index <= MAX_SAVED_SERVERS; index++) {
      await recordSavedServer(`https://s${index}.example.test`, {});
    }
    const hosts = savedServers().map((entry) => entry.apiBase);
    expect(hosts).toHaveLength(MAX_SAVED_SERVERS);
    expect(hosts).not.toContain("https://s0.example.test");
    expect(hosts[0]).toBe(`https://s${MAX_SAVED_SERVERS}.example.test`);
  });

  it("removes one server together with its headers and nothing else", async () => {
    await recordSavedServer(ONE, ACCESS);
    await recordSavedServer(TWO, ACCESS);
    expect(await removeSavedServer(ONE)).toBe(true);
    expect(savedServers()).toEqual([{ apiBase: TWO, headers: ACCESS }]);
    expect(store.get(KEY)).not.toContain(ONE);
    await removeSavedServer(TWO);
    expect(store.has(KEY)).toBe(false);
  });

  it("matches the exact address, not a prefix or another port", async () => {
    await recordSavedServer("https://a.example", {});
    await recordSavedServer("https://a.example.evil", {});
    await recordSavedServer("https://a.example:8443", {});
    await removeSavedServer("https://a.example");
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([
      "https://a.example:8443",
      "https://a.example.evil",
    ]);
  });

  it("starts empty when nothing is stored, the value is damaged, or the read throws", async () => {
    store.set(KEY, "not json");
    await loadSavedServers();
    expect(savedServers()).toEqual([]);
    store.set(KEY, JSON.stringify({ apiBase: ONE }));
    await loadSavedServers();
    expect(savedServers()).toEqual([]);
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked"));
    await loadSavedServers();
    expect(savedServers()).toEqual([]);
  });

  it("drops an entry it could not switch to as it was saved", async () => {
    store.set(
      KEY,
      JSON.stringify([
        { apiBase: ONE, headers: { "bad header": "x" } },
        { apiBase: `${TWO}/path`, headers: {} },
        { apiBase: "http://public.example.test", headers: {} },
        { apiBase: defaultApiBase(), headers: {} },
        { apiBase: 5, headers: {} },
        null,
        { apiBase: TWO },
        { apiBase: "https://ok.example.test", headers: ACCESS },
        { apiBase: "https://ok.example.test", headers: {} },
      ]),
    );
    await loadSavedServers();
    expect(savedServers()).toEqual([{ apiBase: "https://ok.example.test", headers: ACCESS }]);
  });

  it("keeps the list as it was when the write fails", async () => {
    await recordSavedServer(ONE, {});
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
    expect(await recordSavedServer(TWO, {})).toBe(false);
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([ONE]);
    // The last entry goes by deleting the key, which can fail on its own.
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("locked"));
    expect(await removeSavedServer(ONE)).toBe(false);
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([ONE]);
  });

  it("applies overlapping changes one after another", async () => {
    await Promise.all([recordSavedServer(ONE, {}), recordSavedServer(TWO, {})]);
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([TWO, ONE]);
    await loadSavedServers();
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([TWO, ONE]);
  });

  it("does not let a read that started before a write replace the list that write saved", async () => {
    const stale = deferred<string | null>();
    vi.mocked(SecureStore.getItemAsync).mockReturnValueOnce(stale.promise);
    const reading = loadSavedServers();
    const recording = recordSavedServer(ONE, ACCESS);
    await flush();
    stale.resolve(null);
    await Promise.all([reading, recording]);
    expect(savedServers()).toEqual([{ apiBase: ONE, headers: ACCESS }]);
    await recordSavedServer(TWO, {});
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([TWO, ONE]);
    expect(store.get(KEY)).toContain(ONE);
  });

  it("reads the stored list before its first change, so a change before any load keeps it", async () => {
    store.set(KEY, JSON.stringify([{ apiBase: ONE, headers: {} }]));
    vi.resetModules();
    const fresh = await import("./saved-servers");
    expect(await fresh.recordSavedServer(TWO, {})).toBe(true);
    expect(fresh.savedServers().map((entry) => entry.apiBase)).toEqual([TWO, ONE]);
    expect(store.get(KEY)).toContain(ONE);
  });

  it("writes nothing over a list it could not read, and recovers once it can", async () => {
    await recordSavedServer(ONE, ACCESS);
    await recordSavedServer(TWO, ACCESS);
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("locked"));
    await loadSavedServers();
    expect(savedServers()).toEqual([]);
    const before = store.get(KEY);
    expect(await recordSavedServer("https://three.example.test", {})).toBe(false);
    expect(await removeSavedServer(ONE)).toBe(false);
    expect(store.get(KEY)).toBe(before);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
    expect(await recordSavedServer("https://three.example.test", {})).toBe(true);
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([
      "https://three.example.test",
      TWO,
      ONE,
    ]);
  });

  it("keeps the headers a listed server was saved with when it is left with none", async () => {
    await recordSavedServer(ONE, ACCESS);
    await recordSavedServer(TWO, {});
    await recordSavedServer(ONE, {}, { keepHeaders: true });
    expect(savedServers()).toEqual([
      { apiBase: ONE, headers: ACCESS },
      { apiBase: TWO, headers: {} },
    ]);
    await recordSavedServer("https://new.example.test", ACCESS, { keepHeaders: true });
    expect(savedServers()[0]).toEqual({ apiBase: "https://new.example.test", headers: ACCESS });
  });

  it("reports a failed read and a failed write instead of dropping them silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("locked read"));
      await loadSavedServers();
      expect(warn).toHaveBeenCalledWith("Saved servers could not be read", expect.any(Error));
      vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked write"));
      expect(await recordSavedServer(ONE, {})).toBe(false);
      expect(warn).toHaveBeenCalledWith("Saved servers could not be written", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps applying changes after one write failed", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("locked"));
    expect(await recordSavedServer(ONE, {})).toBe(false);
    expect(await recordSavedServer(TWO, {})).toBe(true);
    expect(savedServers().map((entry) => entry.apiBase)).toEqual([TWO]);
  });
});
