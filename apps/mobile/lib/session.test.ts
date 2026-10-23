import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAppBadge, syncAppBadge } from "./app-badge";
import { artifactCacheSession } from "./artifact-cache-session";
import { clearNetworkCache } from "./network-cache.js";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  registerSessionDiskCache,
  restoreSessionToken,
  saveSessionToken,
  saveVerifiedIntegrationsScope,
  snapshotSessionToken,
  subscribeSessionGeneration,
  tokenFromAuthResponse,
} from "./session.js";
import { clearFailedSends } from "./thread-feedback.js";

vi.mock("expo-notifications", () => ({ setBadgeCountAsync: vi.fn(async () => true) }));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./thread-feedback.js", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

describe("mobile session storage", () => {
  beforeEach(async () => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await restoreSessionToken("");
  });

  it("hides the previous bearer while a replacement token is being stored", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("fake-old-token");
    let finish!: () => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeSessionGeneration(listener);
    const saving = saveSessionToken("fake-new-token");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
    finish();
    await saving;
  });

  it("wipes the outbox on sign-in, sign-out and server-session restoration", async () => {
    vi.mocked(clearFailedSends).mockClear();
    await saveSessionToken("fake-a");
    await clearSessionToken();
    await restoreSessionToken("fake-b");
    expect(vi.mocked(clearFailedSends).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("deletes registered disk caches on sign-in, sign-out and restore", async () => {
    const clear = vi.fn();
    registerSessionDiskCache(clear);
    await saveSessionToken("fake-a");
    expect(clear).toHaveBeenCalledTimes(1);
    await clearSessionToken();
    expect(clear).toHaveBeenCalledTimes(2);
    await restoreSessionToken("fake-b");
    expect(clear.mock.calls.length).toBeGreaterThan(2);
  });

  it("clears the icon badge on sign-out and server-session restoration", async () => {
    registerSessionDiskCache(() => void clearAppBadge());
    await syncAppBadge(3);
    vi.mocked(Notifications.setBadgeCountAsync).mockClear();
    await clearSessionToken();
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
    await syncAppBadge(2);
    await restoreSessionToken("fake-other-server");
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
  });

  it("still signs out and runs every other wipe when one disk cache throws", async () => {
    const after = vi.fn();
    registerSessionDiskCache(() => {
      throw new Error("disk unavailable");
    });
    registerSessionDiskCache(after);
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(after).toHaveBeenCalledOnce();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.integrations-scope");
  });

  it("stores and clears only the session token key", async () => {
    await saveSessionToken("secret-token");
    await clearSessionToken();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "secret-token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("rotates the artifact namespace on session save, clear and restore", async () => {
    await saveSessionToken("fake-cache-token");
    let previous = await artifactCacheSession("fake-cache-token");
    for (const change of [
      () => saveSessionToken("fake-cache-token"),
      () => clearSessionToken(),
      () => restoreSessionToken("fake-cache-token"),
    ]) {
      await change();
      const next = await artifactCacheSession("fake-cache-token");
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("clears the system network cache on session save, clear and restore", async () => {
    for (const change of [
      () => saveSessionToken("fake-cache-token"),
      () => clearSessionToken(),
      () => restoreSessionToken("fake-cache-token"),
    ]) {
      vi.mocked(clearNetworkCache).mockClear();
      await change();
      expect(clearNetworkCache).toHaveBeenCalled();
    }
  });

  it("forgets unsent messages on sign-out", async () => {
    vi.mocked(clearFailedSends).mockClear();
    await clearSessionToken();
    expect(clearFailedSends).toHaveBeenCalledOnce();
  });

  it("overwrites the token when SecureStore delete fails", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
    });
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "");
  });

  it("invalidates the in-memory session when SecureStore cannot clear the token", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("secret-token");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when secure storage is empty or unavailable", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(loadSessionToken()).resolves.toBe("");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadSessionToken()).resolves.toBe("");

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(1, "rakazo.session_token");
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(2, "rakazo.session_token");
  });

  it("restores the active session in memory when persistence is unavailable", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await restoreSessionToken("secret-token");
    await expect(loadSessionToken()).resolves.toBe("secret-token");
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "secret-token" });

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("distinguishes an unreadable token store from an empty session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));

    await expect(snapshotSessionToken()).resolves.toEqual({ ok: false });
  });
});

describe("auth response token parsing", () => {
  it("prefers the signed set-auth-token header over the cookie and an unsigned body token", () => {
    const response = new Response(null, {
      headers: {
        "set-auth-token": "header-token.c2lnbmF0dXJl%2B%3D",
        "set-cookie": "better-auth.session_token=cookie-token.sig; Path=/",
      },
    });

    expect(tokenFromAuthResponse(response, { token: "header-token" })).toBe(
      "header-token.c2lnbmF0dXJl+=",
    );
  });

  it("prefers the signed cookie over an unsigned body token", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=cookie-token.sig; Path=/" },
    });

    expect(tokenFromAuthResponse(response, { token: "cookie-token" })).toBe("cookie-token.sig");
  });

  it("falls back to JSON tokens, including nested session responses", () => {
    const response = new Response(null);

    expect(tokenFromAuthResponse(response, { token: "body-token.sig" })).toBe("body-token.sig");
    expect(tokenFromAuthResponse(response, { session: { token: "nested-token.sig" } })).toBe(
      "nested-token.sig",
    );
  });

  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "falls back to and decodes the %s cookie",
    (name) => {
      const response = new Response(null, {
        headers: { "set-cookie": `${name}=abc%2F123%3D; Path=/; HttpOnly` },
      });

      expect(tokenFromAuthResponse(response, {})).toBe("abc/123=");
    },
  );

  it("finds a secure session after another Set-Cookie value", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie":
          "other=value; Path=/, __Secure-better-auth.session_token=secure-token; Path=/; HttpOnly",
      },
    });

    expect(tokenFromAuthResponse(response, {})).toBe("secure-token");
  });

  it("rejects unrelated cookies and malformed response bodies", () => {
    const unrelated = new Response(null, {
      headers: { "set-cookie": "notbetter-auth.session_token=attacker; Path=/" },
    });
    const malformed = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=bad%ZZ; Path=/" },
    });
    expect(tokenFromAuthResponse(unrelated, { token: 123 })).toBe("");
    expect(tokenFromAuthResponse(unrelated, null)).toBe("");
    expect(tokenFromAuthResponse(malformed, {})).toBe("");
  });
});

describe("verified integration session scope", () => {
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  };
  let disk: Map<string, string>;
  beforeEach(async () => {
    disk = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => disk.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await restoreSessionToken("");
    await saveSessionToken("fake-session-a");
  });
  it("loads the scope only for the exact stored session", async () => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    expect(await loadVerifiedIntegrationsScope()).toEqual(scope);
    disk.set("rakazo.session_token", "fake-session-b");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
  it.each(["sign-out", "replacement", "restore"])("invalidates the scope on %s", async (change) => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    if (change === "sign-out") await clearSessionToken();
    if (change === "replacement") await saveSessionToken("fake-session-a");
    if (change === "restore") await restoreSessionToken("fake-session-a");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("rejects a late verification after session replacement", async () => {
    const generation = currentSessionGeneration();
    await saveSessionToken("fake-session-b");
    await saveVerifiedIntegrationsScope(generation, scope);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("serializes an in-flight scope write before sign-out deletes it", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.integrations-scope") await pending;
      disk.set(key, value);
    });
    const saving = saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    await Promise.resolve();
    await Promise.resolve();
    const clearing = clearSessionToken();
    release();
    await Promise.all([saving, clearing]);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
  it("treats malformed stored scopes as misses", async () => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    disk.set("rakazo.integrations-scope", "{");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
});
