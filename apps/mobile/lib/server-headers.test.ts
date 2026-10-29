vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  currentApiBase,
  loadApiBase,
  passwordResetCapabilities,
  resetApiBase,
  saveApiBase,
} from "./api.js";
import { probeApiBase } from "./endpoint.js";
import { fetchServer, serverHeaders, serverHeadersForUrl } from "./server-headers.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

const SERVER = "https://rakazo.example.test";
const ACCESS = { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "secret" };

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetApiBase();
});

describe("server request headers", () => {
  it("preserves fetch options by default and prevents credentialed redirects only when configured", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    const init = { method: "POST", headers: { origin: "rakazo://" } };
    await fetchServer(SERVER, init, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]).toBe(init);
    await saveApiBase(SERVER, ACCESS);
    await fetchServer(`${SERVER}/rpc/me`, { ...init, redirect: "follow" }, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe("error");
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("cf-access-client-secret")).toBe(
      "secret",
    );
    await fetchServer("https://other.example/rpc", init, SERVER, fetchImpl);
    expect(fetchImpl.mock.calls[2]?.[1]).toBe(init);
    expect(serverHeadersForUrl("http://rakazo.example.test/rpc", SERVER)).toEqual({});
    expect(serverHeadersForUrl(`${SERVER}:8443/rpc`, SERVER)).toEqual({});
  });

  it("sends saved headers only to the server they were saved for", async () => {
    await expect(saveApiBase(SERVER, ACCESS)).resolves.toEqual({ ok: true, url: SERVER });

    expect(serverHeaders(currentApiBase())).toEqual(ACCESS);
    expect(await authHeaders(null)).not.toHaveProperty("CF-Access-Client-Secret");
    expect(serverHeadersForUrl(`${SERVER}/rpc/me`, currentApiBase())).toEqual(ACCESS);
    expect(serverHeadersForUrl("https://rakazo.example.test.evil/rpc", SERVER)).toEqual({});
    expect(serverHeadersForUrl("https://other.example.test/rpc", SERVER)).toEqual({});
  });

  it("adds them to unauthenticated auth requests without replacing the caller's own", async () => {
    await saveApiBase(SERVER, ACCESS);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ passwordReset: false, sso: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await passwordResetCapabilities().catch(() => undefined);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cf-access-client-id")).toBe("id.access");
    expect(headers.get("origin")).toBe("rakazo://");
  });

  it("restores saved headers on launch and drops them for another server", async () => {
    await saveApiBase(SERVER, ACCESS);
    await loadApiBase();
    expect(serverHeaders(currentApiBase())).toEqual(ACCESS);

    await saveApiBase("https://second.example.test");
    expect(await authHeaders(null)).not.toHaveProperty("CF-Access-Client-Id");
    expect(store.has("rakazo.server_headers")).toBe(false);
  });

  it("restores headers if saving the endpoint fails", async () => {
    await saveApiBase(SERVER, ACCESS);
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async (key, value) => {
        store.set(key, value);
      })
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(saveApiBase(SERVER, { "X-Access": "replacement" })).resolves.toMatchObject({
      ok: false,
    });
    expect(serverHeaders(SERVER)).toEqual(ACCESS);
  });

  it("does not claim to reset when deleting headers fails", async () => {
    await saveApiBase(SERVER, ACCESS);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.server_headers") throw new Error("Storage unavailable");
      store.delete(key);
    });
    await expect(resetApiBase()).resolves.toMatchObject({ ok: false });
    expect(currentApiBase()).toBe(SERVER);
    expect(serverHeaders(SERVER)).toEqual(ACCESS);
  });

  it("ignores a damaged saved value", async () => {
    store.set("rakazo.api_base", SERVER);
    store.set(
      "rakazo.server_headers",
      JSON.stringify({ apiBase: SERVER, headers: { origin: "x" } }),
    );
    await loadApiBase();
    expect(serverHeaders(SERVER)).toEqual({});
  });

  it("checks a new server with the headers it will use", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ json: { ok: true } })),
    );
    await probeApiBase(SERVER, fetchImpl as typeof fetch, ACCESS);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      ...ACCESS,
      origin: "rakazo://",
    });
  });
});
