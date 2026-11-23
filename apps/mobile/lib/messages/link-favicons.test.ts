vi.mock("../settings/ai-consent", () => ({ promptAiConsent: vi.fn() }));

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentApiBase, subscribeApiBase, subscribeSessionRejected } from "../api/api";
import { resetApiBase, saveApiBase } from "../api/api-server";
import { restoreSessionToken } from "../api/session";
import { loadLinkFavicon } from "./link-favicons";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("../notifications/live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("../api/network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

describe("link favicons on mobile", () => {
  beforeEach(async () => {
    await restoreSessionToken("session-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a late answer after switching servers and notifies cache consumers", async () => {
    const previous = currentApiBase();
    let resolveResponse!: Deferred<Response>;
    const fetchMock = vi.fn(() => {
      resolveResponse = deferred<Response>();
      return resolveResponse.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    const unsubscribe = subscribeApiBase(changed);
    try {
      const pending = loadLinkFavicon("https://site.example.test", previous);
      const rejected = expect(pending).rejects.toThrow("Server changed");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect((await saveApiBase("https://new-api.example.test")).ok).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      resolveResponse.resolve(new Response(JSON.stringify({ json: { icon: null } })));
      await rejected;
    } finally {
      unsubscribe();
      await resetApiBase();
    }
  });

  it("asks the API for an origin's icon", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { icon: "data:image/png;base64,AAAA" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLinkFavicon("https://x.com")).resolves.toEqual({
      icon: "data:image/png;base64,AAAA",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/rpc\/links\/favicon$/),
      expect.objectContaining({ body: JSON.stringify({ json: { origin: "https://x.com" } }) }),
    );
  });

  it.each([
    ["an oRPC not-found error", JSON.stringify({ json: { code: "NOT_FOUND", status: 404 } })],
    ["a plain not-found page", "Cannot POST /rpc/links/favicon"],
  ])("fails quietly on an older server that answers %s", async (_name, body) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);

    // The renderer turns the rejection into the globe and remembers it for the session.
    await expect(loadLinkFavicon("https://x.com")).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    unsubscribe();
  });
});
